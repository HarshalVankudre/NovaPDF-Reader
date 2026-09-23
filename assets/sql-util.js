/*
 * sql-util — dependency-free SQL text helpers shared by the browser sandbox and
 * the Node tests. Pure functions only (no DOM, no engine):
 *   splitStatements(sql, o)  -> string[]  (split on ; honoring quotes/comments)
 *   stripDbStatements(sql)   -> string    (drop CREATE/DROP DATABASE + USE)
 *   toSqlite(mysqlDump)      -> string    (best-effort mysqldump -> SQLite)
 *   csvToSql(table, csvText) -> string    (CSV -> typed CREATE TABLE + INSERTs;
 *                                          ',' / ';' / TAB delimiters auto-detected)
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
  // opts.backslashEscapes=false for SQLite-dialect text, where '\' inside a
  // string is a literal character (only '' escapes a quote).
  function splitStatements(sql, opts) {
    const bsEsc = !(opts && opts.backslashEscapes === false);
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
          if (bsEsc && d === "\\" && quote !== "`") { buf += d + (s[i + 1] || ""); i += 2; continue; }
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

  const CONSTRAINT_START = /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK|FULLTEXT|SPATIAL)\b/i;
  const unquote = (id) => String(id || "").trim().replace(/^[`"\[]|[`"\]]$/g, "");
  const colNameOf = (part) => { const m = /^(`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+)/.exec(part.trim()); return m ? unquote(m[1]) : ""; };
  // single column of a "PRIMARY KEY (`id`)" constraint, or "" if composite/absent
  function singlePkCol(part) {
    const m = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*(?:\w+\s*)?\(([^)]*)\)/i.exec(part.trim());
    if (!m) return "";
    const cols = splitTopLevelCommas(m[1]);
    return cols.length === 1 ? unquote(cols[0].replace(/\(\d+\)\s*$/, "").trim()) : "";
  }

  // extra: { parts: [constraint strings folded in from ALTER TABLE],
  //          autoinc: Set(lower-case column names made AUTO_INCREMENT by ALTER … MODIFY) }
  function cleanCreateTableForSqlite(stmt, extra) {
    // strip table options after the column list: ENGINE=, CHARSET, COLLATE, AUTO_INCREMENT=, ROW_FORMAT, COMMENT
    let s = stmt.replace(/\)\s*(ENGINE|AUTO_INCREMENT|DEFAULT\s+CHARSET|CHARSET|DEFAULT\s+CHARACTER\s+SET|CHARACTER\s+SET|COLLATE|ROW_FORMAT|COMMENT)\b[^;]*$/i, ")");
    // split the inner column/constraint list and drop MySQL-only index lines
    const open = s.indexOf("(");
    const close = s.lastIndexOf(")");
    if (open === -1 || close === -1 || close < open) return s;
    const head = s.slice(0, open + 1);
    const tail = s.slice(close); // ")" + trailing
    const inner = s.slice(open + 1, close);
    const parts = splitTopLevelCommas(inner).concat((extra && extra.parts) || []);

    // MySQL AUTO_INCREMENT on the single-column primary key -> SQLite's
    // "INTEGER PRIMARY KEY AUTOINCREMENT" (a rowid alias), so an INSERT that
    // omits the id still gets one instead of failing NOT NULL.
    const autoinc = new Set((extra && extra.autoinc) || []);
    for (const raw of parts) {
      const p = raw.trim();
      if (p && !CONSTRAINT_START.test(p) && /\bAUTO_INCREMENT\b/i.test(p)) autoinc.add(colNameOf(p).toLowerCase());
    }
    let pkCol = "";
    for (const raw of parts) {
      const p = raw.trim();
      if (CONSTRAINT_START.test(p)) { const c = singlePkCol(p); if (c) pkCol = c.toLowerCase(); }
      else if (/\bPRIMARY\s+KEY\b/i.test(p)) pkCol = colNameOf(p).toLowerCase();
    }
    const promote = pkCol && autoinc.has(pkCol) ? pkCol : "";

    const kept = [];
    for (let raw of parts) {
      let p = raw.trim();
      if (!p) continue;
      if (promote) {
        if (CONSTRAINT_START.test(p) && singlePkCol(p).toLowerCase() === promote) continue; // now inline
        if (!CONSTRAINT_START.test(p) && colNameOf(p).toLowerCase() === promote) {
          kept.push("  " + p.match(/^(`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+)/)[1] + " INTEGER PRIMARY KEY AUTOINCREMENT");
          continue;
        }
      }
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
      p = p.replace(/\bON\s+UPDATE\s+(CURRENT_TIMESTAMP|NOW)(\s*\(\s*\d*\s*\))?/gi, ""); // MySQL-only column clause
      p = p.replace(/\b(CURRENT_TIMESTAMP|NOW)\s*\(\s*\d*\s*\)/gi, "CURRENT_TIMESTAMP");    // MariaDB current_timestamp()
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

  const TABLE_NAME_RE = /^(?:CREATE\s+(?:TEMPORARY\s+)?TABLE|ALTER\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`[^`]+`|"[^"]+"|[\w$]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[\w$]+))?)/i;
  const tableKey = (st) => {
    const m = TABLE_NAME_RE.exec(st);
    if (!m) return "";
    const segs = m[1].split(/\s*\.\s*/);
    return unquote(segs[segs.length - 1]).toLowerCase(); // drop a db. qualifier
  };

  // phpMyAdmin / XAMPP exports declare keys and AUTO_INCREMENT *after* the data:
  //   ALTER TABLE `t` ADD PRIMARY KEY (`id`), ADD KEY `x` (`x`);
  //   ALTER TABLE `t` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;
  //   ALTER TABLE `t` ADD CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `u` (`id`);
  // SQLite can't add constraints after the fact, so fold them back into the
  // CREATE TABLE. Returns { folds: Map(table -> {parts, autoinc}), rest: Map(stmt -> leftover clauses) }.
  function collectAlterFolds(stmts, createdTables) {
    const folds = new Map(), rest = new Map();
    for (const st of stmts) {
      if (!/^ALTER\s+TABLE\b/i.test(st)) continue;
      const key = tableKey(st);
      if (!key || !createdTables.has(key)) continue;
      const m = TABLE_NAME_RE.exec(st);
      const clauses = splitTopLevelCommas(st.slice(m[0].length));
      const f = folds.get(key) || { parts: [], autoinc: [] };
      const left = [];
      for (const raw of clauses) {
        const c = raw.trim();
        if (!c) continue;
        if (/^AUTO_INCREMENT\s*=/i.test(c)) continue;                                   // table option
        if (/^ADD\s+(KEY|INDEX|FULLTEXT|SPATIAL)\b/i.test(c)) continue;                // plain indexes: no semantics
        if (/^ADD\s+(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CHECK\b)/i.test(c)) {
          f.parts.push(c.replace(/^ADD\s+/i, ""));
          continue;
        }
        const mod = /^(?:MODIFY|CHANGE)\s+(?:COLUMN\s+)?(.*)$/i.exec(c);
        if (mod && /\bAUTO_INCREMENT\b/i.test(c)) {
          // CHANGE old new def… — the column that ends up auto-increment is the new name
          const body = /^CHANGE\b/i.test(c) ? mod[1].trim().replace(/^(`[^`]+`|"[^"]+"|[\w$]+)\s+/, "") : mod[1];
          f.autoinc.push(colNameOf(body).toLowerCase());
          continue;
        }
        if (mod) continue; // other MODIFY/CHANGE: type tweaks SQLite doesn't need
        left.push(c);
      }
      folds.set(key, f);
      rest.set(st, left);
    }
    return { folds, rest };
  }

  function toSqlite(dump) {
    const stmts = splitStatements(dump);
    const created = new Set(stmts.filter((st) => /^CREATE\s+(TEMPORARY\s+)?TABLE\b/i.test(st)).map(tableKey));
    const { folds, rest } = collectAlterFolds(stmts, created);
    const out = [];
    for (const st of stmts) {
      if (isNoise(st)) continue;
      if (/^(CREATE\s+DATABASE|CREATE\s+SCHEMA|DROP\s+DATABASE|DROP\s+SCHEMA|USE)\b/i.test(st)) continue;
      if (/^CREATE\s+(TEMPORARY\s+)?TABLE\b/i.test(st)) { out.push(cleanCreateTableForSqlite(st, folds.get(tableKey(st)))); continue; }
      if (rest.has(st)) {
        // SQLite's ALTER TABLE takes one action per statement
        const head = TABLE_NAME_RE.exec(st)[0];
        for (const c of rest.get(st)) out.push(head + " " + c);
        continue;
      }
      if (/^INSERT\b/i.test(st)) { out.push(fixInsertEscapes(st.replace(/^INSERT\s+IGNORE\b/i, "INSERT OR IGNORE"))); continue; }
      out.push(st);
    }
    return out.join(";\n") + (out.length ? ";" : "");
  }

  // --- CSV import (works for both engines) --------------------------------
  // Pick the delimiter from the header line (outside quotes): ',' by default,
  // ';' for German-locale Excel exports, TAB for copied spreadsheet ranges.
  function detectDelimiter(text) {
    const s = String(text || "");
    const counts = { ",": 0, ";": 0, "\t": 0 };
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && (c === "\n" || c === "\r")) break;
      else if (!inQ && c in counts) counts[c]++;
    }
    let best = ",";
    for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
    return best;
  }

  function parseCsv(text, delim) {
    const rows = [];
    let row = [], field = "", i = 0, inQ = false;
    const s = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const n = s.length;
    const sep = delim || detectDelimiter(s);
    while (i < n) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === sep) { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ""));
  }

  const sqlStr = (v) => (v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
  const ident = (name) => "`" + String(name).replace(/[`\n]/g, "").trim() + "`";

  // Infer INTEGER / REAL / TEXT per column so numeric WHERE comparisons and
  // ORDER BY behave numerically (an all-TEXT column sorts "100" before "50").
  // Values with a leading zero ("007", PLZ "01069") stay TEXT. In ';'-separated
  // files a decimal comma ("3,50") counts as a number and is stored as 3.50.
  const INT_RE = /^-?(0|[1-9]\d{0,14})$/;
  function numericValue(v, decimalComma) {
    const t = String(v).trim();
    if (INT_RE.test(t)) return { kind: "INTEGER", sql: t };
    const dec = decimalComma ? t.replace(/^(-?\d+),(\d+)$/, "$1.$2") : t;
    if (/^-?(0|[1-9]\d*)\.\d+$/.test(dec)) return { kind: "REAL", sql: dec };
    return null;
  }
  function inferColumnTypes(body, ncols, decimalComma) {
    const types = [];
    for (let c = 0; c < ncols; c++) {
      let kind = "", seen = 0;
      for (const r of body) {
        const v = r[c];
        if (v == null || String(v).trim() === "") continue;
        seen++;
        const nv = numericValue(v, decimalComma);
        if (!nv) { kind = "TEXT"; break; }
        if (kind !== "REAL") kind = nv.kind;
      }
      types.push(seen ? kind : "TEXT");
    }
    return types;
  }

  function csvToSql(table, csvText) {
    const delim = detectDelimiter(String(csvText || "").replace(/^\uFEFF/, ""));
    const rows = parseCsv(csvText, delim);
    if (!rows.length) return "";
    const cols = rows[0].map((c, idx) => (c && c.trim()) ? c.trim() : "col" + (idx + 1));
    const t = ident(table || "daten");
    const body = rows.slice(1);
    const types = inferColumnTypes(body, cols.length, delim === ";");
    let out = "DROP TABLE IF EXISTS " + t + ";\nCREATE TABLE " + t + " (\n  " +
      cols.map((c, idx) => ident(c) + " " + types[idx]).join(",\n  ") + "\n);\n";
    for (const r of body) {
      const vals = cols.map((_, idx) => {
        const v = r[idx];
        if (types[idx] === "TEXT") return sqlStr(v);
        if (v == null || String(v).trim() === "") return "NULL";
        return numericValue(v, delim === ";").sql;
      });
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

  return { splitStatements, stripDbStatements, toSqlite, cleanCreateTableForSqlite, fixInsertEscapes, detectDelimiter, parseCsv, csvToSql, detectImportKind };
});
