/*
 * sql-util — dependency-free SQL text helpers shared by the browser sandbox and
 * the Node tests. Pure functions only (no DOM, no engine):
 *   splitStatements(sql)     -> string[]  (split on ; honoring quotes/comments)
 *   stripDbStatements(sql)   -> string    (drop CREATE/DROP DATABASE + USE)
 *   toSqlite(mysqlDump)      -> string    (best-effort mysqldump -> SQLite)
 *   csvToSql(table, csvText) -> string    (CSV -> CREATE TABLE + INSERTs)
 *   detectImportKind(text)   -> 'sql' | 'csv'
 *   adaptMysql(sql)          -> string    (course MySQL idioms -> SQLite, for the offline engine)
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

  // --- MySQL query idioms the lectures use, rewritten so they run on SQLite ----
  // Only the offline engine calls this. Real MySQL stays untouched, and the
  // rewrite never touches text inside strings, comments, or backtick bodies
  // except to turn `ident` into a quoted SQLite identifier.
  function sqlLiteral(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }
  function unquoteIdent(tok) {
    tok = String(tok || "").trim();
    if (tok.length >= 2 && tok[0] === "`" && tok[tok.length - 1] === "`") return tok.slice(1, -1).replace(/``/g, "`");
    if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') return tok.slice(1, -1).replace(/""/g, '"');
    return tok;
  }
  function copyQuoted(s, i) {
    const q = s[i];
    let j = i + 1;
    while (j < s.length) {
      const d = s[j];
      if (d === "\\" && q !== "`") { j += 2; continue; }
      j++;
      if (d === q) {
        if (s[j] === q) { j++; continue; }
        break;
      }
    }
    return j;
  }
  function parseCallArgs(s, openIdx) {
    let i = openIdx + 1;
    let buf = "";
    let depth = 1;
    const args = [];
    while (i < s.length) {
      const c = s[i];
      if (c === "'" || c === '"' || c === "`") {
        const end = copyQuoted(s, i);
        buf += s.slice(i, end);
        i = end;
        continue;
      }
      if (c === "(") { depth++; buf += c; i++; continue; }
      if (c === ")") {
        depth--;
        if (depth === 0) {
          if (!(args.length === 0 && buf.trim() === "")) args.push(buf);
          return { args, end: i + 1 };
        }
        buf += c; i++; continue;
      }
      if (c === "," && depth === 1) { args.push(buf); buf = ""; i++; continue; }
      buf += c; i++;
    }
    return null;
  }
  function tryCall(s, i) {
    if (i > 0 && /[A-Za-z0-9_]/.test(s[i - 1])) return null;
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) return null;
    let j = i + m[0].length;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] !== "(") return null;
    const parsed = parseCallArgs(s, j);
    if (!parsed) return null;
    return { name: m[0], args: parsed.args, end: parsed.end };
  }
  function tryLimit(s, i) {
    if (i > 0 && /[A-Za-z0-9_]/.test(s[i - 1])) return null;
    const m = /^LIMIT\s+(\d+)\s*,\s*(\d+)/i.exec(s.slice(i));
    if (!m) return null;
    return { text: "LIMIT " + m[2] + " OFFSET " + m[1], end: i + m[0].length };
  }
  function dayNameExpr(expr) {
    return "CASE CAST(strftime('%w', " + expr + ") AS INTEGER)" +
      " WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'" +
      " WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'" +
      " WHEN 6 THEN 'Saturday' END";
  }
  function timePart(fmt, expr) {
    return "CAST(strftime('" + fmt + "', " + expr + ") AS INTEGER)";
  }
  function timestampDiff(unitRaw, start, end) {
    const unit = String(unitRaw || "").trim().replace(/^['"`]+|['"`]+$/g, "").toLowerCase();
    const delta = "(julianday(" + end + ") - julianday(" + start + "))";
    if (unit === "year") return "(CAST(strftime('%Y', " + end + ") AS INTEGER) - CAST(strftime('%Y', " + start + ") AS INTEGER))";
    if (unit === "month") {
      return "((CAST(strftime('%Y', " + end + ") AS INTEGER) - CAST(strftime('%Y', " + start + ") AS INTEGER)) * 12" +
        " + CAST(strftime('%m', " + end + ") AS INTEGER) - CAST(strftime('%m', " + start + ") AS INTEGER))";
    }
    if (unit === "day") return "CAST(" + delta + " AS INTEGER)";
    if (unit === "hour") return "CAST(" + delta + " * 24 AS INTEGER)";
    if (unit === "minute") return "CAST(" + delta + " * 1440 AS INTEGER)";
    if (unit === "second") return "CAST(" + delta + " * 86400 AS INTEGER)";
    return null;
  }
  function emitCall(name, args) {
    const n = name.toUpperCase();
    const pass = name + "(" + args.join(", ") + ")";
    if ((n === "CURDATE" || n === "CURRENT_DATE") && args.length === 0) return "date('now')";
    if ((n === "CURTIME" || n === "CURRENT_TIME") && args.length === 0) return "time('now')";
    if ((n === "NOW" || n === "CURRENT_TIMESTAMP") && args.length === 0) return "datetime('now')";
    if (n === "YEAR" && args.length === 1) return timePart("%Y", args[0]);
    if (n === "MONTH" && args.length === 1) return timePart("%m", args[0]);
    if (n === "DAY" && args.length === 1) return timePart("%d", args[0]);
    if (n === "HOUR" && args.length === 1) return timePart("%H", args[0]);
    if (n === "MINUTE" && args.length === 1) return timePart("%M", args[0]);
    if (n === "SECOND" && args.length === 1) return timePart("%S", args[0]);
    if (n === "DAYNAME" && args.length === 1) return dayNameExpr(args[0]);
    if (n === "DATEDIFF" && args.length === 2) {
      return "CAST(julianday(date(" + args[0] + ")) - julianday(date(" + args[1] + ")) AS INTEGER)";
    }
    if (n === "TIMESTAMPDIFF" && args.length === 3) {
      const rewritten = timestampDiff(args[0], args[1], args[2]);
      if (rewritten) return rewritten;
    }
    if (n === "IF" && args.length === 3) return "CASE WHEN " + args[0] + " THEN " + args[1] + " ELSE " + args[2] + " END";
    if (n === "CONCAT" && args.length >= 1) return "(" + args.join(" || ") + ")";
    if (n === "GROUP_CONCAT" && args.length === 1) {
      const sep = /^([\s\S]+?)\s+SEPARATOR\s+([\s\S]+)$/i.exec(args[0]);
      if (sep) return "group_concat(" + sep[1] + ", " + sep[2] + ")";
    }
    return pass;
  }
  function rewriteBody(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if ((c === "-" && s[i + 1] === "-") || c === "#") {
        const nl = s.indexOf("\n", i);
        const end = nl === -1 ? s.length : nl + 1;
        out += s.slice(i, end);
        i = end;
        continue;
      }
      if (c === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        const to = end === -1 ? s.length : end + 2;
        out += s.slice(i, to);
        i = to;
        continue;
      }
      if (c === "'" || c === '"') {
        const end = copyQuoted(s, i);
        out += s.slice(i, end);
        i = end;
        continue;
      }
      if (c === "`") {
        const end = copyQuoted(s, i);
        const raw = s.slice(i + 1, end - 1).replace(/``/g, "`");
        out += '"' + raw.replace(/"/g, '""') + '"';
        i = end;
        continue;
      }
      const lim = tryLimit(s, i);
      if (lim) { out += lim.text; i = lim.end; continue; }
      const call = tryCall(s, i);
      if (call) {
        out += emitCall(call.name, call.args.map((a) => rewriteBody(a.trim())));
        i = call.end;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }
  function adaptStatement(st) {
    const s = st.trim();
    let m = /^show\s+tables(?:\s+like\s+('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|\S+))?\s*$/i.exec(s);
    if (m) {
      const like = m[1] ? " AND name LIKE " + (/^['"]/.test(m[1]) ? m[1] : sqlLiteral(m[1])) : "";
      return "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'" + like + " ORDER BY name";
    }
    m = /^show\s+create\s+table\s+(.+?)\s*$/i.exec(s);
    if (m) return "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = " + sqlLiteral(unquoteIdent(m[1]));
    m = /^show\s+columns\s+from\s+(\S+)\s*$/i.exec(s);
    if (m) return "PRAGMA table_info(" + sqlLiteral(unquoteIdent(m[1])) + ")";
    m = /^(?:describe|desc)\s+(\S+)\s*$/i.exec(s);
    if (m) return "PRAGMA table_info(" + sqlLiteral(unquoteIdent(m[1])) + ")";
    return rewriteBody(s);
  }
  function adaptMysql(sql) {
    const parts = splitStatements(sql);
    if (!parts.length) return String(sql || "");
    return parts.map(adaptStatement).join(";\n") + ";";
  }

  return { splitStatements, stripDbStatements, toSqlite, cleanCreateTableForSqlite, fixInsertEscapes, parseCsv, csvToSql, detectImportKind, adaptMysql };
});
