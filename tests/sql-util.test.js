/* Unit tests for the pure SQL helpers (assets/sql-util.js).
 * Run: node tests/sql-util.test.js
 * These cover statement splitting, mysqldump -> SQLite cleaning, DB-statement
 * stripping, and CSV import — the parts of the sandbox that don't need a live DB.
 */
const assert = require("assert");
const U = require("../assets/sql-util.js");

const bt = (s) => s.replace(/#/g, "`"); // write backticks as # to dodge escaping noise

// --- splitStatements ---------------------------------------------------------
{
  const sql = "SELECT 1; SELECT 'a;b'; -- a comment;\nSELECT \"c;d\"; /* x;y */ SELECT 3;";
  const parts = U.splitStatements(sql);
  assert.deepStrictEqual(parts, ["SELECT 1", "SELECT 'a;b'", "SELECT \"c;d\"", "SELECT 3"], "splits on ; honoring quotes/comments");
}
{
  // backslash-escaped quote inside a string must not end the string early
  const parts = U.splitStatements("INSERT INTO t VALUES ('O\\'Brien;x'); SELECT 2;");
  assert.strictEqual(parts.length, 2, "backslash-escaped quote keeps the statement whole");
}

// --- stripDbStatements -------------------------------------------------------
{
  const sql = "CREATE DATABASE foo; USE foo; CREATE TABLE t (id int); INSERT INTO t VALUES (1);";
  const out = U.stripDbStatements(sql);
  assert.ok(!/CREATE DATABASE/i.test(out), "CREATE DATABASE removed");
  assert.ok(!/\bUSE\b/i.test(out), "USE removed");
  assert.ok(/CREATE TABLE/i.test(out) && /INSERT INTO/i.test(out), "table + data kept");
}

// --- toSqlite (mysqldump -> SQLite) -----------------------------------------
{
  const dump = bt([
    "/*!40101 SET NAMES utf8 */;",
    "DROP TABLE IF EXISTS #kunde#;",
    "CREATE TABLE #kunde# (",
    "  #id# int(11) NOT NULL AUTO_INCREMENT,",
    "  #name# varchar(100) NOT NULL,",
    "  #stadt# enum('KA','B') DEFAULT NULL,",
    "  PRIMARY KEY (#id#),",
    "  KEY #idx_name# (#name#)",
    ") ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4;",
    "INSERT INTO #kunde# VALUES (1,'O\\'Brien','KA'),(2,'M\\u00fcller',NULL);",
  ].join("\n"));
  const out = U.toSqlite(dump);
  assert.ok(!/ENGINE=/i.test(out), "ENGINE option stripped");
  assert.ok(!/AUTO_INCREMENT/i.test(out), "AUTO_INCREMENT stripped");
  assert.ok(!/DEFAULT CHARSET/i.test(out), "CHARSET option stripped");
  assert.ok(!/\bKEY\s+`?idx_name/i.test(out), "non-unique KEY index line dropped");
  assert.ok(/\btext\b/i.test(out) && !/enum\(/i.test(out), "ENUM converted to text");
  assert.ok(/PRIMARY KEY/i.test(out), "PRIMARY KEY constraint kept");
  assert.ok(out.indexOf("'O''Brien'") !== -1, "backslash-escaped quote converted to SQLite doubling");
  assert.ok(!/SET NAMES/i.test(out), "SET statement dropped");
}

// --- csvToSql ----------------------------------------------------------------
{
  const out = U.csvToSql("t", 'a,b\n1,"x,y"\n2,z');
  assert.ok(/CREATE TABLE `t`/.test(out), "creates table with given name");
  assert.ok(/`a` TEXT/.test(out) && /`b` TEXT/.test(out), "columns from header row");
  assert.ok(/VALUES \('1', 'x,y'\)/.test(out), "quoted CSV field with comma preserved");
}

// --- detectImportKind --------------------------------------------------------
assert.strictEqual(U.detectImportKind("CREATE TABLE t (id int);"), "sql");
assert.strictEqual(U.detectImportKind("a,b,c\n1,2,3"), "csv");

// --- adaptMysql: lecture SQL that SQLite would otherwise reject ------------
{
  const q = "select bestnr, datediff('2020-12-24', bestelldatum) as tage from bestellung";
  const out = U.adaptMysql(q);
  assert.ok(/julianday\(date\('2020-12-24'\)\)/.test(out), "DATEDIFF keeps the date literal and uses julianday");
  assert.ok(/julianday\(date\(bestelldatum\)\)/.test(out), "DATEDIFF second argument is the column");
  assert.ok(!/datediff\s*\(/i.test(out), "DATEDIFF call is rewritten");
}
{
  const out = U.adaptMysql("select timestampdiff(day, angelegt_am, curdate()) as alter_in_tagen from produkt");
  assert.ok(/julianday\(date\('now'\)\)/.test(out), "CURDATE inside TIMESTAMPDIFF becomes date('now')");
  assert.ok(/julianday\(angelegt_am\)/.test(out), "TIMESTAMPDIFF start column stays");
  assert.ok(!/timestampdiff|curdate/i.test(out), "both MySQL calls are gone");
}
{
  const out = U.adaptMysql("select year(bestellzeitpunkt), month(bestellzeitpunkt), hour(bestellzeitpunkt) from bestellung");
  assert.ok(/strftime\('%Y', bestellzeitpunkt\)/.test(out), "YEAR");
  assert.ok(/strftime\('%m', bestellzeitpunkt\)/.test(out), "MONTH");
  assert.ok(/strftime\('%H', bestellzeitpunkt\)/.test(out), "HOUR");
}
{
  const out = U.adaptMysql("select * from bestellung where dayname(bestelldatum) = 'Monday'");
  assert.ok(/THEN 'Monday'/.test(out) && /strftime\('%w', bestelldatum\)/.test(out), "DAYNAME speaks English, as the slide compares");
}
{
  const out = U.adaptMysql("SELECT 'datediff(1, 2)' AS s, `name` FROM `kunde` LIMIT 1, 2");
  assert.ok(out.indexOf("'datediff(1, 2)'") !== -1, "function text inside a string is left alone");
  assert.ok(/"name"/.test(out) && /"kunde"/.test(out), "backticks become quoted identifiers");
  assert.ok(/LIMIT 2 OFFSET 1/.test(out), "MySQL LIMIT offset,count becomes LIMIT count OFFSET offset");
}
{
  const out = U.adaptMysql("DROP TABLE IF EXISTS t; SHOW TABLES; DESCRIBE `kunde`;");
  assert.ok(/DROP TABLE IF EXISTS t/.test(out), "IF EXISTS is not the IF() function");
  assert.ok(/sqlite_master/.test(out) && /PRAGMA table_info\('kunde'\)/.test(out), "SHOW TABLES and DESCRIBE");
}
{
  const out = U.adaptMysql("SELECT IF(i > 3, CONCAT('a', 'b'), 'n') FROM n");
  assert.ok(/CASE WHEN i > 3 THEN \('a' \|\| 'b'\) ELSE 'n' END/.test(out), "IF and CONCAT");
}

(async () => {
  const path = require("path");
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const db = new SQL.Database();
  db.run("CREATE TABLE bestellung (bestnr INTEGER, bestelldatum TEXT, bestellzeitpunkt TEXT);");
  db.run("INSERT INTO bestellung VALUES (1, '2020-12-01', '2020-12-21 22:15:00');");
  db.run("CREATE TABLE kunde (id INTEGER, name TEXT);");
  db.run("INSERT INTO kunde VALUES (1, 'Ann'), (2, 'Bo'), (3, 'Cy'), (4, 'Di'), (5, 'Ed');");
  const one = (sql) => {
    const res = db.exec(U.adaptMysql(sql));
    if (!res.length || !res[0].values.length) throw new Error("no row for " + sql + " -> " + U.adaptMysql(sql));
    return res[0].values[0];
  };
  assert.strictEqual(one("select datediff('2020-12-24', bestelldatum) from bestellung")[0], 23, "DATEDIFF days until Christmas");
  assert.strictEqual(one("select datediff(bestelldatum, '2020-12-24') from bestellung")[0], -23, "DATEDIFF is signed");
  assert.strictEqual(one("select year(bestellzeitpunkt) from bestellung")[0], 2020, "YEAR");
  assert.strictEqual(one("select month(bestellzeitpunkt) from bestellung")[0], 12, "MONTH");
  assert.strictEqual(one("select hour(bestellzeitpunkt) from bestellung")[0], 22, "HOUR for the night-order task");
  assert.strictEqual(one("select dayname(bestellzeitpunkt) from bestellung")[0], "Monday", "2020-12-21 was a Monday");
  assert.strictEqual(one("select timestampdiff(day, '2020-12-01', curdate())")[0] >= 0, true, "TIMESTAMPDIFF(day) runs");
  const page = db.exec(U.adaptMysql("SELECT name FROM kunde ORDER BY id LIMIT 1, 2"))[0].values.map((r) => r[0]);
  assert.deepStrictEqual(page, ["Bo", "Cy"], "LIMIT offset,count");
  const tables = db.exec(U.adaptMysql("SHOW TABLES"))[0].values.map((r) => r[0]);
  assert.ok(tables.indexOf("kunde") !== -1 && tables.indexOf("bestellung") !== -1, "SHOW TABLES");
  const cols = db.exec(U.adaptMysql("DESCRIBE kunde"))[0].values.map((r) => r[1]);
  assert.deepStrictEqual(cols, ["id", "name"], "DESCRIBE");
  assert.strictEqual(one("SELECT IF(id > 3, 'y', 'n') FROM kunde WHERE id = 4")[0], "y", "IF()");
  console.log("sql-util checks passed");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
