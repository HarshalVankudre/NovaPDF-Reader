/*
 * sql-util — dependency-free SQL text helpers shared by the browser sandbox and
 * the Node tests. Pure functions only (no DOM, no engine):
 *   splitStatements(sql)     -> string[]  (split on ; honoring quotes/comments)
 *   stripDbStatements(sql)   -> string    (drop CREATE/DROP DATABASE + USE)
 *   toSqlite(mysqlDump)      -> string    (best-effort mysqldump -> SQLite)
 *   csvToSql(table, csvText) -> string    (CSV -> CREATE TABLE + INSERTs)
 *   detectImportKind(text)   -> 'sql' | 'csv'
 *
 * The SQLite conversion is intentionally best-effort: it exists only for the
 * no-MySQL fallback path. The accurate path is the real local MySQL bridge.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (typeof window !== "undefined") window.SqlUtil = mod;
  else if (typeof globalThis !== "undefined") globalThis.SqlUtil = mod;
})(this, function () {
  "use strict";

  // Split a SQL script into individual statements, respecting '...' and "..."
  // strings (with backslash escapes), `backtick` identifiers, -- / # line
  // comments and /* */ block comments. Returns trimmed, non-empty statements.
  function splitStatements(sql) {
    const out = [];
    let buf = "";
    const s = String(sql || "");
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      // line comments
      if ((c === "-" && s[i + 1] === "-") || c === "#") {
        // -- must be followed by whitespace/EOL to be a comment (MySQL rule),
        // but mysqldump always emits "-- "; treat both '#' and '--' as comments.
        const nl = s.indexOf("\n", i);
        i = nl === -1 ? n : nl + 1;
        continue;
      }
      // block comment
      if (c === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      // quoted string / identifier
      if (c === "'" || c === '"' || c === "`") {
        const quote = c;
        buf += c; i++;
        while (i < n) {
          const d = s[i];
          if (d === "\\" && quote !== "`") { buf += d + (s[i + 1] || ""); i += 2; continue; }
          buf += d; i++;
          if (d === quote) {
            if (s[i] === quote) { buf += s[i]; i++; continue; } // escaped quote by doubling
            break;
          }
        }
        continue;
      }
      if (c === ";") { const t = buf.trim(); if (t) out.push(t); buf = ""; i++; continue; }
      buf += c; i++;
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
    return out;
  }

  const isNoise = (st) =>
    /^(SET|LOCK\s+TABLES|UNLOCK\s+TABLES|DELIMITER|START\s+TRANSACTION|COMMIT|BEGIN)\b/i.test(st) ||
    /^\/\*/.test(st) || st === "";

  // Remove CREATE/DROP DATABASE and USE statements so an import lands in a fixed
  // sandbox schema regardless of what the dump names its database.
  function stripDbStatements(sql) {
    return splitStatements(sql)
      .filter((st) => !/^(CREATE\s+DATABASE|CREATE\s+SCHEMA|DROP\s+DATABASE|DROP\s+SCHEMA|USE)\b/i.test(st))
      .join(";\n") + (splitStatements(sql).length ? ";" : "");
  }

  function cleanCreateTableForSqlite(stmt) {
    // strip table options after the column list: ENGINE=, CHARSET, COLLATE, AUTO_INCREMENT=, ROW_FORMAT, COMMENT
    let s = stmt.replace(/\)\s*(ENGINE|AUTO_INCREMENT|DEFAULT\s+CHARSET|CHARSET|DEFAULT\s+CHARACTER\s+SET|CHARACTER\s+SET|COLLATE|ROW_FORMAT|COMMENT)\b[^;]*$/i, ")");
    // split the inner column/constraint list and drop MySQL-only index lines
    const open = s.indexOf("(");
    const close = s.lastIndexOf(")");
    if (open === -1 || close === -1 || close < open) return s;
    const head = s.slice(0, open + 1);
    const tail = s.slice(close); // ")" + trailing
    const inner = s.slice(open + 1, close);
    const parts = splitTopLevelCommas(inner);
    const kept = [];
    for (let raw of parts) {
      let p = raw.trim();
      if (!p) continue;
      if (/^(KEY|INDEX|FULLTEXT|SPATIAL)\b/i.test(p)) continue;             // non-unique indexes: unsupported inline
      if (/^CONSTRAINT\b.*\bFOREIGN\s+KEY\b/i.test(p)) {                     // keep FK but drop the CONSTRAINT name
        p = p.replace(/^CONSTRAINT\s+(`[^`]+`|"[^"]+"|\w+)\s+/i, "");
      }
      p = p.replace(/^UNIQUE\s+KEY\s+(`[^`]+`|"[^"]+"|\w+)\s*/i, "UNIQUE "); // UNIQUE KEY name (..) -> UNIQUE (..)
      p = p.replace(/\bAUTO_INCREMENT\b/gi, "");                             // SQLite auto-assigns rowid
      p = p.replace(/\bunsigned\b/gi, "");
      p = p.replace(/\benum\s*\([^)]*\)/gi, "text");                         // ENUM -> text
      p = p.replace(/\bset\s*\([^)]*\)/gi, "text");                          // SET(...) -> text
      p = p.replace(/\bCHARACTER\s+SET\s+\w+/gi, "");
      p = p.replace(/\bCOLLATE\s+\w+/gi, "");
      p = p.replace(/\bCOMMENT\s+'(?:[^'\\]|\\.|'')*'/gi, "");
      p = p.replace(/\s{2,}/g, " ").trim().replace(/,$/, "");
      if (p) kept.push("  " + p);
    }
    return head + "\n" + kept.join(",\n") + "\n" + tail;
  }

  function splitTopLevelCommas(s) {
    const out = [];
    let buf = "", depth = 0, i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === "'" || c === '"' || c === "`") {
        const q = c; buf += c; i++;
        while (i < n) { const d = s[i]; if (d === "\\" && q !== "`") { buf += d + (s[i + 1] || ""); i += 2; continue; } buf += d; i++; if (d === q) { if (s[i] === q) { buf += s[i]; i++; continue; } break; } }
        continue;
      }
      if (c === "(") { depth++; buf += c; i++; continue; }
      if (c === ")") { depth--; buf += c; i++; continue; }
      if (c === "," && depth === 0) { out.push(buf); buf = ""; i++; continue; }
      buf += c; i++;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  // Convert mysqldump backslash escaping inside '...' literals to SQLite's form.
  function fixInsertEscapes(stmt) {
    let out = "";
    let i = 0; const n = stmt.length;
    while (i < n) {
      const c = stmt[i];
      if (c === "'") {
        out += "'"; i++;
        while (i < n) {
          const d = stmt[i];
          if (d === "\\") {
            const e = stmt[i + 1];
            if (e === "'") out += "''";
            else if (e === "\\") out += "\\";
            else if (e === "n") out += "\n";
            else if (e === "r") out += "\r";
            else if (e === "t") out += "\t";
            else if (e === "0") out += "";
            else if (e === '"') out += '"';
            else out += (e || "");
            i += 2; continue;
          }
          if (d === "'") { if (stmt[i + 1] === "'") { out += "''"; i += 2; continue; } out += "'"; i++; break; }
          out += d; i++;
        }
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  function toSqlite(dump) {
    const stmts = splitStatements(dump);
    const out = [];
    for (const st of stmts) {
      if (isNoise(st)) continue;
      if (/^(CREATE\s+DATABASE|CREATE\s+SCHEMA|DROP\s+DATABASE|DROP\s+SCHEMA|USE)\b/i.test(st)) continue;
      if (/^CREATE\s+TABLE\b/i.test(st)) { out.push(cleanCreateTableForSqlite(st)); continue; }
      if (/^INSERT\b/i.test(st)) { out.push(fixInsertEscapes(st)); continue; }
      out.push(st);
    }
    return out.join(";\n") + (out.length ? ";" : "");
  }

  // --- CSV import (works for both engines) --------------------------------
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", i = 0, inQ = false;
    const s = String(text || "").replace(/\r\n?/g, "\n");
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === ";" && rows.length === 0 && row.length === 0 && field === "" && s.indexOf(",") === -1) { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  }

  const sqlStr = (v) => (v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
  const ident = (name) => "`" + String(name).replace(/[`\n]/g, "").trim() + "`";

  function csvToSql(table, csvText) {
    const rows = parseCsv(csvText);
    if (!rows.length) return "";
    const cols = rows[0].map((c, idx) => (c && c.trim()) ? c.trim() : "col" + (idx + 1));
    const t = ident(table || "daten");
    let out = "DROP TABLE IF EXISTS " + t + ";\nCREATE TABLE " + t + " (\n  " +
      cols.map((c) => ident(c) + " TEXT").join(",\n  ") + "\n);\n";
    const body = rows.slice(1);
    for (const r of body) {
      const vals = cols.map((_, idx) => sqlStr(r[idx]));
      out += "INSERT INTO " + t + " VALUES (" + vals.join(", ") + ");\n";
    }
    return out;
  }

  function detectImportKind(text) {
    const head = String(text || "").trim().slice(0, 4000).toUpperCase();
    if (/\b(CREATE\s+TABLE|INSERT\s+INTO|CREATE\s+DATABASE|DROP\s+TABLE)\b/.test(head)) return "sql";
    // CSV heuristic: first non-empty line has commas and no SQL keyword
    return "csv";
  }

  return { splitStatements, stripDbStatements, toSqlite, cleanCreateTableForSqlite, fixInsertEscapes, parseCsv, csvToSql, detectImportKind };
});
