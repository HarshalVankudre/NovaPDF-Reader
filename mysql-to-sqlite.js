#!/usr/bin/env node
/*
 * mysql-to-sqlite.js — fast one-shot snapshot of a live MySQL/MariaDB database
 * into a single SQLite file that the app loads instantly (no dump parsing).
 *
 * Exam-day usage (give Claude Code the credentials and run this):
 *   node mysql-to-sqlite.js --host db.example.com --user u --password PW --database examdb
 *   node mysql-to-sqlite.js --database examdb            # other values from serve.config.json / env
 *
 * TLS (common for remote/cloud MySQL):
 *   --ssl                    enable TLS (system CAs)
 *   --ssl-ca ca.pem          TLS with a provided CA certificate file
 *   --ssl-cert c.pem --ssl-key k.pem   mutual TLS (client cert)
 *   --ssl-insecure           TLS without verifying the server cert (self-signed)
 *
 * Defaults come from serve.config.json's "mysql" block (incl. an optional "ssl"
 * object) and MYSQL_* env vars, so usually you only pass --database (and creds).
 * Output goes to data/exam.sqlite by default, which the app auto-loads on opening
 * the sandbox. (The DB is assumed MySQL/MariaDB — if the exam DB is a SQLite file,
 * skip this entirely and drag the file into the app. If it's PostgreSQL, ask for a
 * pg variant.)
 *
 * Pure JS: mysql2 (read) + sql.js (build/export). Streams each table inside one
 * transaction for speed. Real data + sensible SQLite types — accurate for query
 * practice (note: SQLite dialect differs from MySQL for some functions).
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    let t = argv[i];
    if (!t.startsWith("--")) continue;
    t = t.slice(2);
    const eq = t.indexOf("=");
    if (eq !== -1) { a[t.slice(0, eq)] = t.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { a[t] = argv[++i]; }
    else { a[t] = true; }
  }
  return a;
}

function loadDefaults(root) {
  let cfg = {};
  try { const p = path.join(root, "serve.config.json"); if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
  const m = cfg.mysql || {};
  const e = process.env;
  return {
    host: e.MYSQL_HOST || m.host || "127.0.0.1",
    port: parseInt(e.MYSQL_PORT || m.port || 3306, 10) || 3306,
    user: e.MYSQL_USER || m.user || "root",
    password: e.MYSQL_PASSWORD != null ? e.MYSQL_PASSWORD : (m.password != null ? m.password : ""),
    database: e.MYSQL_DATABASE || m.database || "",
    ssl: m.ssl, // optional object from serve.config.json (e.g. { ca: "ca.pem", rejectUnauthorized: true })
  };
}

// Build the mysql2 `ssl` option from flags/config. Returns undefined for a plain
// (non-TLS) connection. Many cloud MySQL hosts require TLS, sometimes with a CA file.
//   --ssl                enable TLS with system CAs
//   --ssl-ca <file>      CA certificate (PEM); implies TLS
//   --ssl-cert/--ssl-key client cert/key for mutual TLS (PEM)
//   --ssl-insecure       TLS but don't verify the server cert (self-signed)
function buildSsl(args, d) {
  const caFile = args["ssl-ca"] || (d.ssl && d.ssl.ca);
  const certFile = args["ssl-cert"] || (d.ssl && d.ssl.cert);
  const keyFile = args["ssl-key"] || (d.ssl && d.ssl.key);
  const insecure = args["ssl-insecure"] === true || args["ssl-insecure"] === "true" || (d.ssl && d.ssl.rejectUnauthorized === false);
  const want = args.ssl === true || args.ssl === "true" || caFile || certFile || keyFile || insecure || (d.ssl != null && d.ssl !== false);
  if (!want) return undefined;
  const ssl = {};
  if (caFile) ssl.ca = fs.readFileSync(path.resolve(String(caFile)));
  if (certFile) ssl.cert = fs.readFileSync(path.resolve(String(certFile)));
  if (keyFile) ssl.key = fs.readFileSync(path.resolve(String(keyFile)));
  if (insecure) ssl.rejectUnauthorized = false;
  if (d.ssl && typeof d.ssl === "object") { if (d.ssl.minVersion) ssl.minVersion = d.ssl.minVersion; if (d.ssl.servername) ssl.servername = d.ssl.servername; }
  return ssl;
}

// MySQL data_type -> SQLite column affinity
function sqliteType(dataType) {
  const t = String(dataType || "").toLowerCase();
  if (/(^|_)(tinyint|smallint|mediumint|int|integer|bigint|bit|bool)/.test(t)) return "INTEGER";
  if (/(decimal|numeric|float|double|real)/.test(t)) return "REAL";
  if (/(blob|binary)/.test(t)) return "BLOB";
  return "TEXT"; // char/varchar/text/enum/set/json/date/datetime/timestamp/time/year
}
const q = (id) => "`" + String(id).replace(/`/g, "``") + "`";

// Convert a mysql2 cell into something sql.js can bind.
function conv(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 19).replace("T", " ");
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

async function main() {
  const root = path.resolve(__dirname);
  const args = parseArgs(process.argv);
  const d = loadDefaults(root);
  const conf = {
    host: args.host || d.host,
    port: parseInt(args.port || d.port, 10) || 3306,
    user: args.user || d.user,
    password: args.password != null ? args.password : d.password,
    database: args.database || d.database,
    ssl: buildSsl(args, d),
  };
  const out = path.resolve(root, args.out || path.join("data", "exam.sqlite"));
  if (!conf.database) {
    console.error(
      "Missing --database (the MySQL schema to snapshot). Examples:\n" +
      "  node mysql-to-sqlite.js --host db.example.com --user u --password PW --database examdb\n" +
      "  node mysql-to-sqlite.js --host ... --user ... --password ... --database ... --ssl            (TLS)\n" +
      "  node mysql-to-sqlite.js --host ... --user ... --password ... --database ... --ssl-ca ca.pem  (TLS + CA file)\n" +
      "  add --ssl-insecure if the server uses a self-signed cert");
    process.exit(2);
  }

  let mysql, initSqlJs;
  try { mysql = require("mysql2/promise"); } catch (e) { console.error("mysql2 missing — run: npm install"); process.exit(2); }
  try { initSqlJs = require("sql.js"); } catch (e) { console.error("sql.js missing — run: npm install"); process.exit(2); }

  const t0 = Date.now();
  console.log("Connecting to mysql://" + conf.user + "@" + conf.host + ":" + conf.port + "/" + conf.database +
    (conf.ssl ? " [TLS" + (conf.ssl.rejectUnauthorized === false ? ", no-verify" : "") + (conf.ssl.ca ? ", CA file" : "") + "]" : "") + " …");
  const connOpts = {
    host: conf.host, port: conf.port, user: conf.user, password: conf.password, database: conf.database,
    connectTimeout: 12000, supportBigNumbers: true, bigNumberStrings: false, dateStrings: false,
  };
  if (conf.ssl) connOpts.ssl = conf.ssl;
  const conn = await mysql.createConnection(connOpts);
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  const [tableRows] = await conn.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [conf.database]);
  const tables = tableRows.map((r) => r.t);
  if (!tables.length) { console.warn("No base tables found in " + conf.database + "."); }

  let totalRows = 0;
  const summary = [];
  for (const t of tables) {
    const [cols] = await conn.query(
      "SELECT column_name AS c, data_type AS dt, column_key AS k FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position", [conf.database, t]);
    if (!cols.length) continue;
    const pk = cols.filter((c) => c.k === "PRI").map((c) => q(c.c));
    const defs = cols.map((c) => q(c.c) + " " + sqliteType(c.dt));
    const create = "CREATE TABLE " + q(t) + " (\n  " + defs.join(",\n  ") +
      (pk.length ? ",\n  PRIMARY KEY (" + pk.join(", ") + ")" : "") + "\n)";
    db.run(create);

    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare("INSERT INTO " + q(t) + " VALUES (" + placeholders + ")");
    db.run("BEGIN");
    let n = 0;
    await new Promise((resolve, reject) => {
      const s = conn.query({ sql: "SELECT * FROM " + q(t), rowsAsArray: true }).stream();
      s.on("data", (row) => { try { stmt.run(row.map(conv)); n++; } catch (e) { s.destroy(e); } });
      s.on("end", resolve);
      s.on("error", reject);
    });
    db.run("COMMIT");
    stmt.free();
    totalRows += n;
    summary.push({ table: t, rows: n, cols: cols.length });
    console.log("  " + t.padEnd(28) + n + " rows");
  }
  await conn.end();

  const bytes = db.export();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(bytes));
  db.close();

  const ms = Date.now() - t0;
  const kb = (bytes.length / 1024).toFixed(0);
  console.log("\n✔ Snapshot written: " + out);
  console.log("  " + tables.length + " tables, " + totalRows + " rows, " + kb + " KB, " + ms + " ms");
  console.log("  Open the app → SQL sandbox; it auto-loads this file (or drag it in).");
}

main().catch((e) => { console.error("\nExport failed: " + ((e && e.message) || e)); process.exit(1); });
