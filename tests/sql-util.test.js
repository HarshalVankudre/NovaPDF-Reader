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

{
  // SQLite dialect: a backslash is literal, so 'C:\' ends the string
  const sqliteText = "INSERT INTO t VALUES ('C:\\'); INSERT INTO t VALUES ('x;y'); SELECT 1;";
  assert.strictEqual(U.splitStatements(sqliteText, { backslashEscapes: false }).length, 3, "literal backslash doesn't swallow the quote");
  // and the converter's output round-trips through that split
  const conv = U.toSqlite("INSERT INTO t VALUES ('C:\\\\');\nINSERT INTO t VALUES ('b');");
  assert.deepStrictEqual(U.splitStatements(conv, { backslashEscapes: false }), ["INSERT INTO t VALUES ('C:\\')", "INSERT INTO t VALUES ('b')"]);
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
  assert.ok(/`a` INTEGER/.test(out) && /`b` TEXT/.test(out), "columns from header row, numeric column typed");
  assert.ok(/VALUES \(1, 'x,y'\)/.test(out), "quoted CSV field with comma preserved");
}
{
  // German-locale Excel export: ';' delimiter, decimal comma, BOM, leading-zero PLZ stays text
  const out = U.csvToSql("artikel", "\uFEFFnr;name;preis;plz\r\n1;Tisch;3,50;01069\r\n2;\"Stuhl; rot\";12;10115\r\n3;Bank;;80331\r\n");
  assert.strictEqual(U.detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.strictEqual(U.detectDelimiter("a\tb\n1\t2"), "\t");
  assert.strictEqual(U.detectDelimiter('"x;y",b\n1,2'), ",", "delimiters inside quotes don't count");
  assert.ok(/`nr` INTEGER/.test(out) && /`preis` REAL/.test(out) && /`plz` TEXT/.test(out), "types inferred: " + out);
  assert.ok(/VALUES \(1, 'Tisch', 3\.50, '01069'\)/.test(out), "decimal comma -> dot, PLZ quoted");
  assert.ok(/'Stuhl; rot'/.test(out), "quoted ';' kept inside field");
  assert.ok(/VALUES \(3, 'Bank', NULL, '80331'\)/.test(out), "empty numeric cell -> NULL");
}

// --- phpMyAdmin / XAMPP export: keys + AUTO_INCREMENT arrive via ALTER TABLE ---
const PMA = bt([
  "SET SQL_MODE = \"NO_AUTO_VALUE_ON_ZERO\";",
  "START TRANSACTION;",
  "CREATE TABLE #kunde# (",
  "  #id# int(11) NOT NULL,",
  "  #email# varchar(100) NOT NULL,",
  "  #angelegt# timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;",
  "INSERT INTO #kunde# (#id#, #email#) VALUES (1, 'a@x.de'), (2, 'b@x.de');",
  "CREATE TABLE #bestellung# (",
  "  #nr# int(11) NOT NULL,",
  "  #kunde_id# int(11) NOT NULL,",
  "  #betrag# decimal(8,2) DEFAULT NULL",
  ") ENGINE=InnoDB;",
  "INSERT IGNORE INTO #bestellung# VALUES (10, 1, 9.90), (10, 1, 9.90);",
  "ALTER TABLE #kunde#",
  "  ADD PRIMARY KEY (#id#),",
  "  ADD UNIQUE KEY #email# (#email#);",
  "ALTER TABLE #bestellung#",
  "  ADD PRIMARY KEY (#nr#),",
  "  ADD KEY #kunde_id# (#kunde_id#);",
  "ALTER TABLE #kunde#",
  "  MODIFY #id# int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;",
  "ALTER TABLE #bestellung#",
  "  ADD CONSTRAINT #fk_kunde# FOREIGN KEY (#kunde_id#) REFERENCES #kunde# (#id#) ON DELETE CASCADE;",
  "COMMIT;",
].join("\n"));
{
  const out = U.toSqlite(PMA);
  assert.ok(!/ALTER TABLE/i.test(out), "all ALTER TABLE clauses folded into CREATE TABLE: " + out);
  assert.ok(/`id` INTEGER PRIMARY KEY AUTOINCREMENT/.test(out), "AUTO_INCREMENT pk promoted");
  assert.ok(/UNIQUE \(`email`\)/.test(out), "UNIQUE KEY folded in");
  assert.ok(/FOREIGN KEY \(`kunde_id`\) REFERENCES `kunde`/.test(out), "FK folded in");
  assert.ok(!/ON UPDATE current_timestamp/i.test(out) && /DEFAULT CURRENT_TIMESTAMP/.test(out), "ON UPDATE dropped, current_timestamp() normalized");
  assert.ok(/INSERT OR IGNORE INTO/.test(out), "INSERT IGNORE -> INSERT OR IGNORE");
}
{
  // inline AUTO_INCREMENT + table-level PRIMARY KEY (plain mysqldump shape)
  const out = U.toSqlite(bt("CREATE TABLE #t# (#id# int NOT NULL AUTO_INCREMENT, #x# int, PRIMARY KEY (#id#)) ENGINE=InnoDB;"));
  assert.ok(/`id` INTEGER PRIMARY KEY AUTOINCREMENT/.test(out) && !/PRIMARY KEY \(`id`\)/.test(out), "inline auto_increment promoted: " + out);
  // composite PK: AUTO_INCREMENT can't be promoted, keep the constraint
  const out2 = U.toSqlite(bt("CREATE TABLE #t# (#a# int NOT NULL AUTO_INCREMENT, #b# int NOT NULL, PRIMARY KEY (#a#, #b#));"));
  assert.ok(/PRIMARY KEY \(`a`, `b`\)/.test(out2) && !/AUTOINCREMENT/.test(out2), "composite pk untouched");
}

// --- end-to-end: the converted SQL really runs in SQLite (vendored sql.js) ---
const path = require("path");
require("../assets/sql-wasm.js")({ locateFile: () => path.join(__dirname, "..", "assets", "sql-wasm.wasm") }).then((SQL) => {
  const db = new SQL.Database();
  db.run(U.toSqlite(PMA));
  db.run("INSERT INTO kunde (email) VALUES ('c@x.de')"); // id omitted -> auto-assigned
  const ids = db.exec("SELECT id FROM kunde ORDER BY id")[0].values.map((r) => r[0]);
  assert.deepStrictEqual(ids, [1, 2, 3], "auto-increment continues after imported rows");
  assert.throws(() => db.run("INSERT INTO kunde (email) VALUES ('a@x.de')"), /UNIQUE/, "folded UNIQUE enforced");
  assert.strictEqual(db.exec("SELECT COUNT(*) FROM bestellung")[0].values[0][0], 1, "INSERT OR IGNORE skipped the duplicate");

  const csv = new SQL.Database();
  csv.run(U.csvToSql("p", "name;preis\nA;100\nB;50\nC;7,5"));
  const order = csv.exec("SELECT name FROM p WHERE preis > 20 ORDER BY preis")[0].values.map((r) => r[0]);
  assert.deepStrictEqual(order, ["B", "A"], "typed CSV columns compare and sort numerically");

  console.log("sql-util checks passed");
}).catch((e) => { console.error(e); process.exit(1); });

// --- detectImportKind --------------------------------------------------------
assert.strictEqual(U.detectImportKind("CREATE TABLE t (id int);"), "sql");
assert.strictEqual(U.detectImportKind("a,b,c\n1,2,3"), "csv");
