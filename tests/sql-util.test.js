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

console.log("sql-util checks passed");
