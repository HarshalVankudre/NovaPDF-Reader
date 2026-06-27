/* ============ SQL sandbox ============
 * A query console over the imported exam database. Two engines, auto-selected:
 *   - MySQL  : the local server's /sql bridge (exam-exact dialect). Preferred.
 *   - SQLite : in-browser sql.js (WASM), offline fallback when MySQL is down.
 * Import accepts a mysqldump / plain SQL script, or CSV-per-table. The AI's
 * generated SQL gets a Run button that executes here against the imported data.
 *
 * Exposes window.SqlSandbox: { open, close, toggle, isOpen, runInline }.
 */
(function () {
  "use strict";
  const U = window.SqlUtil;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let engine = null;        // 'mysql' | 'sqlite'
  let forced = null;        // user override: 'sqlite' to force offline
  let status = null;        // last /sql/status payload
  let sqlite = null;        // { SQL, db }
  let panel = null, backdrop = null, editorEl = null, resultsEl = null, engineEl = null;
  let booted = false;
  let schemaCache = null;   // compact schema string for the tutor; rebuilt after import
  let isSnapshot = false;   // a real SQLite snapshot file is loaded (exact data)
  let snapshotName = "";
  let lastTableCount = 0;
  let autoTried = false;    // only auto-load the snapshot once per session

  const SQLITE_MAGIC = "SQLite format 3"; // 15 chars; the 16th header byte is a NUL
  function isSqliteBytes(buf) {
    if (!buf || buf.byteLength < 16) return false;
    const h = new Uint8Array(buf, 0, 16);
    for (let i = 0; i < 15; i++) if (h[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
    return h[15] === 0;
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Konnte " + src + " nicht laden"));
      document.head.appendChild(s);
    });
  }

  async function probeMysql() {
    try {
      const r = await fetch("/sql/status", { cache: "no-store" });
      status = await r.json();
    } catch (e) { status = { available: false, reason: "Server nicht erreichbar" }; }
    return status;
  }
  let sqliteInit = null; // memoize: concurrent callers must share ONE init, or a
                         // late init can clobber a freshly-imported db with an empty one
  function ensureSqlite() {
    if (sqlite && sqlite.db) return Promise.resolve(sqlite);
    if (!sqliteInit) sqliteInit = (async () => {
      if (typeof initSqlJs === "undefined") await loadScript("assets/sql-wasm.js");
      const SQL = await initSqlJs({ locateFile: () => "assets/sql-wasm.wasm" });
      sqlite = { SQL, db: new SQL.Database() };
      return sqlite;
    })();
    return sqliteInit;
  }
  // Decide the active engine. MySQL wins unless the user forced SQLite.
  async function ensureEngine(reprobe) {
    if (forced === "sqlite") { await ensureSqlite(); engine = "sqlite"; return engine; }
    if (!status || reprobe) await probeMysql();
    if (status && status.available) { engine = "mysql"; return engine; }
    await ensureSqlite(); engine = "sqlite"; return engine;
  }

  function tableNameFromFile(name) {
    return (String(name || "daten").replace(/\.[^.]+$/, "").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "daten").toLowerCase();
  }

  // ---- import ----
  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const bufs = await Promise.all(files.map((f) => f.arrayBuffer()));
    // A binary SQLite file (the exam snapshot) loads directly — instant, exact, no parsing.
    for (let i = 0; i < files.length; i++) if (isSqliteBytes(bufs[i])) return loadSqliteBytes(bufs[i], files[i].name);
    const parsed = files.map((f, i) => ({ name: f.name, text: new TextDecoder().decode(bufs[i]) }));
    return importParsed(parsed);
  }
  // Load a ready-made SQLite database from bytes (a .sqlite snapshot file).
  async function loadSqliteBytes(buf, label) {
    await ensureSqlite();
    forced = "sqlite"; engine = "sqlite";          // a snapshot is authoritative; stay on it
    sqlite.db = new sqlite.SQL.Database(new Uint8Array(buf));
    schemaCache = null; isSnapshot = true; snapshotName = label || "snapshot";
    const tables = listSqliteTables();
    lastTableCount = tables.length;
    return { engine: "sqlite", snapshot: true, tables };
  }
  // Fetch + load the server-side snapshot file (data/exam.sqlite by default).
  async function loadSnapshot() {
    const r = await fetch("/sql/file", { cache: "no-store" });
    if (!r.ok) throw new Error("Keine Snapshot-Datei gefunden (data/exam.sqlite)");
    const buf = await r.arrayBuffer();
    if (!isSqliteBytes(buf)) throw new Error("Datei ist keine gültige SQLite-DB");
    return loadSqliteBytes(buf, "exam.sqlite");
  }
  async function snapshotStatus() {
    try { const r = await fetch("/sql/filestatus", { cache: "no-store" }); return await r.json(); }
    catch (e) { return { exists: false }; }
  }
  async function importParsed(parsed) {
    await ensureEngine();
    const rawParts = [], sqliteParts = [];
    for (const { name, text } of parsed) {
      const isCsv = /\.csv$/i.test(name) || U.detectImportKind(text) === "csv";
      if (isCsv) { const s = U.csvToSql(tableNameFromFile(name), text); rawParts.push(s); sqliteParts.push(s); }
      else { rawParts.push(text); sqliteParts.push(U.toSqlite(text)); }
    }
    if (engine === "mysql") return importMysql(rawParts.join("\n\n"));
    return importSqlite(sqliteParts.join("\n\n"));
  }
  async function importMysql(sql) {
    const r = await fetch("/sql/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Import fehlgeschlagen");
    status = null; schemaCache = null; isSnapshot = false; // tables changed
    return j;
  }
  async function importSqlite(sql) {
    await ensureSqlite();
    sqlite.db = new sqlite.SQL.Database(); // clean slate, like the MySQL import
    sqlite.db.run(sql);
    schemaCache = null; isSnapshot = false;
    const tables = listSqliteTables();
    lastTableCount = tables.length;
    return { engine: "sqlite", tables };
  }
  function listSqliteTables() {
    try {
      const r = sqlite.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      if (!r.length) return [];
      return r[0].values.map((v) => {
        const t = v[0];
        let rows = 0;
        try { rows = sqlite.db.exec("SELECT COUNT(*) FROM `" + t + "`")[0].values[0][0]; } catch (e) {}
        return { name: t, rows };
      });
    } catch (e) { return []; }
  }

  // Compact schema string for the tutor (so its SQL uses the real table/column
  // names). Only built once the sandbox has been engaged, to avoid probing on
  // every text question. Cached; invalidated on import / engine switch.
  function sqliteSchema() {
    const out = [];
    try {
      const tables = sqlite.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      if (!tables.length) return out;
      for (const v of tables[0].values) {
        const t = v[0]; const cols = [];
        try { const info = sqlite.db.exec("PRAGMA table_info(`" + t + "`)"); if (info.length) for (const c of info[0].values) cols.push({ name: c[1], type: c[2] }); } catch (e) {}
        out.push({ name: t, columns: cols });
      }
    } catch (e) {}
    return out;
  }
  async function schemaText() {
    if (!booted) return "";
    if (schemaCache != null) return schemaCache;
    let tables = [];
    try {
      if (engine === "mysql") { const r = await fetch("/sql/schema", { cache: "no-store" }); const j = await r.json(); tables = j.tables || []; }
      else if (engine === "sqlite" && sqlite && sqlite.db) { tables = sqliteSchema(); }
    } catch (e) { tables = []; }
    schemaCache = tables.length
      ? tables.map((t) => t.name + "(" + (t.columns || []).map((c) => c.name + (c.type ? " " + c.type : "")).join(", ") + ")").join("\n")
      : "";
    return schemaCache;
  }

  // ---- query ----
  async function runSql(sql) {
    await ensureEngine();
    if (engine === "mysql") {
      const r = await fetch("/sql/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Abfrage fehlgeschlagen");
      return j.sets || [];
    }
    return sqliteQuery(sql);
  }
  function sqliteQuery(sql) {
    const db = sqlite.db;
    const res = db.exec(sql);
    if (res.length) return res.map((r) => ({ columns: r.columns, rows: r.values, rowCount: r.values.length }));
    let mod = 0; try { mod = db.getRowsModified(); } catch (e) {}
    return [{ columns: ["Ergebnis"], rows: [["OK · " + mod + " Zeile(n) geändert"]], rowCount: 0 }];
  }

  // ---- rendering ----
  function setTableHtml(sets) {
    if (!sets || !sets.length) return '<div class="sbx-empty">Kein Ergebnis.</div>';
    return sets.map((s) => {
      const head = "<tr>" + (s.columns || []).map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr>";
      const body = (s.rows || []).map((row) =>
        "<tr>" + row.map((cell) => "<td>" + (cell == null ? '<span class="sbx-null">NULL</span>' : esc(cell)) + "</td>").join("") + "</tr>"
      ).join("");
      const count = '<div class="sbx-count">' + (s.rowCount || 0) + " Zeile(n)</div>";
      return '<div class="sbx-set"><div class="sbx-tablewrap"><table class="sbx-table"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>" + count + "</div>";
    }).join("");
  }
  function showResult(html) { if (resultsEl) resultsEl.innerHTML = html; }
  function errHtml(msg) { return '<div class="sbx-err">' + esc(msg) + "</div>"; }

  function updateEngineBadge() {
    if (!engineEl) return;
    if (engine === "mysql") {
      const n = (status && status.tables && status.tables.length) || 0;
      engineEl.className = "sbx-engine ok";
      engineEl.innerHTML = "MySQL ✓ <small>" + esc((status && status.database) || "") + " · " + n + " Tab.</small>";
      engineEl.title = "Exam-genau (lokale MySQL). Klicken: zu SQLite wechseln.";
    } else if (isSnapshot) {
      engineEl.className = "sbx-engine ok";
      engineEl.innerHTML = "SQLite ✓ <small>Snapshot · " + lastTableCount + " Tab.</small>";
      engineEl.title = "Echter Daten-Snapshot (" + esc(snapshotName) + "). Klicken: MySQL erneut prüfen.";
    } else {
      engineEl.className = "sbx-engine warn";
      engineEl.innerHTML = "SQLite ⚠ <small>offline · ≈MySQL</small>";
      engineEl.title = (status && status.reason ? "MySQL nicht erreichbar: " + status.reason + ". " : "") + "Klicken: MySQL erneut prüfen.";
    }
  }
  async function toggleEngine() {
    schemaCache = null; isSnapshot = false;
    if (engine === "mysql") { forced = "sqlite"; await ensureEngine(); }
    else { forced = null; await ensureEngine(true); }
    updateEngineBadge();
  }

  // ---- panel ----
  function build() {
    if (panel) return;
    backdrop = document.createElement("div"); backdrop.className = "sbx-backdrop"; backdrop.hidden = true;
    backdrop.addEventListener("click", close);
    panel = document.createElement("div"); panel.className = "sbx-panel"; panel.hidden = true;
    panel.innerHTML =
      '<div class="sbx-head"><span class="sbx-title">Abfrage</span><span class="sbx-engine" id="sbxEngine">…</span>' +
      '<button class="sbx-x" title="Schließen (Esc)" aria-label="Schließen">&times;</button></div>' +
      '<div class="sbx-tools">' +
      '<button class="sbx-btn sbx-run">Ausführen ▷</button>' +
      '<button class="sbx-btn sbx-ghost sbx-snap" hidden>Exam-DB laden</button>' +
      '<button class="sbx-btn sbx-ghost sbx-import">Als DB importieren</button>' +
      '<label class="sbx-btn sbx-ghost sbx-file">Datei…<input type="file" multiple accept=".sqlite,.sqlite3,.db,.sql,.csv,.txt" hidden></label>' +
      '<span class="sbx-hint">.sqlite / Dump / CSV hierher ziehen · Strg+Enter</span></div>' +
      '<textarea class="sbx-editor" spellcheck="false" placeholder="SELECT * FROM ...   (oder Dump einfügen und „Als DB importieren“)"></textarea>' +
      '<div class="sbx-results" id="sbxResults"><div class="sbx-empty">Noch keine Abfrage. Importiere zuerst die Datenbank.</div></div>';
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    editorEl = panel.querySelector(".sbx-editor");
    resultsEl = panel.querySelector("#sbxResults");
    engineEl = panel.querySelector("#sbxEngine");

    panel.querySelector(".sbx-x").addEventListener("click", close);
    engineEl.addEventListener("click", () => { toggleEngine().catch(() => {}); });
    panel.querySelector(".sbx-run").addEventListener("click", runFromEditor);
    panel.querySelector(".sbx-import").addEventListener("click", importFromEditor);
    panel.querySelector(".sbx-snap").addEventListener("click", () => doImport(loadSnapshot));
    panel.querySelector(".sbx-file input").addEventListener("change", (e) => { doImport(() => importFiles(e.target.files)); e.target.value = ""; });

    editorEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runFromEditor(); }
      if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    // drag & drop a dump / CSVs onto the panel
    ["dragover", "dragenter"].forEach((ev) => panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.add("sbx-drag"); }));
    ["dragleave", "drop"].forEach((ev) => panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.remove("sbx-drag"); }));
    panel.addEventListener("drop", (e) => { const fs = e.dataTransfer && e.dataTransfer.files; if (fs && fs.length) doImport(() => importFiles(fs)); });
  }

  function busy(on, label) {
    const run = panel.querySelector(".sbx-run");
    panel.classList.toggle("sbx-busy", !!on);
    if (run) run.disabled = !!on;
    if (on && label) showResult('<div class="sbx-empty">' + esc(label) + "</div>");
  }

  async function doImport(fn) {
    build(); busy(true, "Importiere…");
    try {
      const r = await fn();
      await ensureEngine(true); // refresh table list/badge
      updateEngineBadge();
      const tabs = (r && r.tables) || [];
      const list = tabs.length ? tabs.map((t) => "<code>" + esc(t.name) + "</code> <span class='sbx-dim'>(" + (t.rows || 0) + ")</span>").join(" · ") : "(keine Tabellen erkannt)";
      const label = r && r.snapshot ? "Snapshot geladen — " + tabs.length + " Tabellen" : "Import ok — " + (r && r.engine === "sqlite" ? "SQLite" : "MySQL");
      showResult('<div class="sbx-ok">' + label + "</div><div class='sbx-tablelist'>" + list + "</div>");
      if (tabs.length && editorEl && !editorEl.value.trim()) editorEl.value = "SELECT * FROM " + tabs[0].name + " LIMIT 50;";
    } catch (e) {
      showResult(errHtml((e && e.message) || "Import fehlgeschlagen"));
    } finally { busy(false); }
  }
  function importFromEditor() {
    const text = editorEl.value.trim();
    if (!text) { showResult(errHtml("Editor ist leer — Dump einfügen oder Datei ziehen.")); return; }
    doImport(() => importParsed([{ name: "einfügen.sql", text }]));
  }
  async function runFromEditor() {
    const sql = editorEl.value.trim();
    if (!sql) return;
    build(); busy(true, "Führe aus…");
    try {
      const sets = await runSql(sql);
      updateEngineBadge();
      showResult(setTableHtml(sets));
    } catch (e) {
      showResult(errHtml((e && e.message) || "Abfrage fehlgeschlagen"));
    } finally { busy(false); }
  }

  // Run SQL from an AI answer and render the result right under its code block.
  async function runInline(afterEl, sql, btn) {
    let out = afterEl.nextElementSibling;
    if (!out || !out.classList.contains("nt-sql-result")) {
      out = document.createElement("div"); out.className = "nt-sql-result";
      afterEl.parentNode.insertBefore(out, afterEl.nextSibling);
    }
    out.innerHTML = '<div class="sbx-empty">Führe aus…</div>';
    if (btn) btn.disabled = true;
    try {
      const sets = await runSql(sql);
      out.innerHTML = setTableHtml(sets);
    } catch (e) {
      out.innerHTML = errHtml((e && e.message) || "Fehler");
    } finally { if (btn) btn.disabled = false; }
  }

  function open() {
    build();
    backdrop.hidden = false; panel.hidden = false;
    if (!booted) { booted = true; ensureEngine().then(updateEngineBadge).catch(() => { updateEngineBadge(); }); }
    else updateEngineBadge();
    // Surface the exam snapshot if the server has one; auto-load it once so the
    // 5-minute window is just "run mysql-to-sqlite.js → open → query".
    snapshotStatus().then((st) => {
      const snapBtn = panel.querySelector(".sbx-snap");
      if (st && st.exists) {
        if (snapBtn) { snapBtn.hidden = false; snapBtn.textContent = "Exam-DB laden" + (st.size ? " (" + Math.max(1, Math.round(st.size / 1024)) + " KB)" : ""); }
        if (!autoTried && !isSnapshot) { autoTried = true; doImport(loadSnapshot); }
      } else if (snapBtn) { snapBtn.hidden = true; }
    }).catch(() => {});
    setTimeout(() => { if (editorEl) editorEl.focus(); }, 30);
  }
  function close() { if (panel) panel.hidden = true; if (backdrop) backdrop.hidden = true; }
  function isOpen() { return !!(panel && !panel.hidden); }
  function toggle() { isOpen() ? close() : open(); }

  window.SqlSandbox = { open, close, toggle, isOpen, runInline, importFiles, schemaText };
})();
