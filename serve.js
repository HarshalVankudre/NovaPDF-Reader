/* Robust static file server for DB Slide Finder.
 * Node's http + streaming handles the 14 MB PDF reliably (Python's
 * http.server drops/empties large files on Windows). Run: node serve.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  createLLMConfig,
  selectProviderForMessages,
  providerChainForMessages,
  messagesContainImage,
  buildOpenAIRequestBody,
} = require("./llm-config");
const SqlUtil = require("./assets/sql-util.js");

// When packaged as a single .exe (pkg), the static assets ship next to the
// executable rather than inside the virtual snapshot, so resolve ROOT to the
// exe's own folder. Running normally (node serve.js) keeps __dirname.
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname);
const ROOT_PREFIX = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const PORT = parseInt(process.env.PORT || "8000", 10);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function sendJson(res, code, obj) {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function sendText(res, code, text, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(code, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, headers));
  res.end(text);
}

function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendText(res, 405, "Method Not Allowed", { Allow: methods.join(", ") });
  return false;
}

function readJsonBody(req, res, maxBytes, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  req.on("data", (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > maxBytes) {
      done = true;
      chunks.length = 0;
      sendJson(res, 413, { error: "Request body too large" });
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => {
    done = true;
    try { res.destroy(); } catch {}
  });
  req.on("end", () => {
    if (done) return;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch (e) { return sendJson(res, 400, { error: "Invalid JSON body" }); }
    cb(payload);
  });
}

function insideRoot(filePath) {
  const resolved = path.resolve(filePath);
  return resolved === ROOT || resolved.startsWith(ROOT_PREFIX);
}

function staticBlock(filePath) {
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { code: 403, text: "Forbidden" };
  const parts = rel.split(path.sep);
  if (parts.some((part) => part.startsWith("."))) return { code: 403, text: "Forbidden" };
  const base = parts[parts.length - 1].toLowerCase();
  if (base === "serve.config.json" || base.startsWith("serve.config.local")) return { code: 403, text: "Forbidden" };
  if (/^assets[\\/]lectures[\\/]vl\d+\.pdf$/i.test(rel)) return { code: 404, text: "Not found" };
  return null;
}

function parseByteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end >= size) end = size - 1;
  }
  if (start < 0 || start >= size || start > end) return null;
  return { start, end };
}

// ===================== LLM proxy (keys stay server-side) =====================
// API keys come from environment variables, or a gitignored serve.config.json.
// The browser never sees a key — it POSTs to /llm and this server calls the LLM.
// Keys/config are read from ROOT by default, but SLIDEFINDER_CONFIG_DIR lets you
// keep secrets in a different folder (handy for tests and for keeping keys out of
// the served directory entirely). Static files are always served from ROOT.
const CONFIG_DIR = process.env.SLIDEFINDER_CONFIG_DIR ? path.resolve(process.env.SLIDEFINDER_CONFIG_DIR) : ROOT;
function loadConfig() {
  try {
    const p = path.join(CONFIG_DIR, "serve.config.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { console.warn("serve.config.json parse error:", e.message); }
  return {};
}
const CONFIG = loadConfig();
const LLM = createLLMConfig(CONFIG_DIR, CONFIG);
const KEYS = LLM.keys;
const PROVIDERS = LLM.providers;

const SYSTEM_PROMPT =
  'You are a precise study assistant for the German university database course ' +
  '"DSCB140 - Datenbanken & Datenkunde". You receive a student QUESTION and several candidate ' +
  'lecture SLIDES (each with a global page number, its lecture, a title, and extracted text). ' +
  'Identify which slide(s) best answer the question, then write a short, correct answer GROUNDED ' +
  'ONLY in those slides - never invent facts not present in them. Answer in the SAME language as ' +
  'the question, concisely (2-6 sentences). If none of the slides answer it, say so briefly and ' +
  'use an empty slides list. Return ONLY a JSON object (no markdown, no code fences) of the exact ' +
  'form: {"answer": "...", "slides": [<global page numbers you actually used, most relevant first>]}';

function buildUserPrompt(question, candidates) {
  let s = "QUESTION: " + question + "\n\nCANDIDATE SLIDES:\n";
  for (const c of candidates) {
    s += "\n[S." + c.page + " | " + (c.lecture || "") + " | " + (c.title || "") + "]\n" +
         String(c.text || "").slice(0, 800) + "\n";
  }
  return s;
}

function parseAnswer(raw) {
  let obj = null;
  try { obj = JSON.parse(raw); }
  catch (e) {
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} }
  }
  if (!obj || typeof obj !== "object") return { answer: (raw || "").trim() || "No answer.", slides: [] };
  const slides = Array.isArray(obj.slides) ? obj.slides.map(Number).filter((n) => n > 0) : [];
  return { answer: String(obj.answer == null ? "" : obj.answer).trim(), slides };
}

async function askAnthropic(p, key, system, user) {
  let Anthropic;
  try { Anthropic = require("@anthropic-ai/sdk"); }
  catch (e) { const err = new Error("Anthropic SDK missing - run: npm install @anthropic-ai/sdk"); err.status = 500; throw err; }
  const client = new Anthropic({ apiKey: key });
  const msg = await client.messages.create({
    model: p.model,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { raw: text, model: msg.model || p.model };
}

async function askOpenAICompatible(p, key, system, user) {
  const resp = await fetch(p.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(buildOpenAIRequestBody(p, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: 1024,
      temperature: 0.2,
      response_format: { type: "json_object" },
    })),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const err = new Error(p.label + " API error " + resp.status + ": " + t.slice(0, 300));
    err.status = resp.status === 401 ? 401 : 502;
    throw err;
  }
  const data = await resp.json();
  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return { raw: text, model: (data && data.model) || p.model };
}

async function askLLM(question, candidates) {
  const p = PROVIDERS.glm;
  const key = KEYS.glm;
  if (!key) {
    const e = new Error("No API key for " + p.label + ". Set " + p.envHint + " (environment variable) or add it to serve.config.json, then restart the server.");
    e.status = 400; throw e;
  }
  const user = buildUserPrompt(question, candidates);
  const t0 = Date.now();
  const out = p.kind === "anthropic" ? await askAnthropic(p, key, SYSTEM_PROMPT, user) : await askOpenAICompatible(p, key, SYSTEM_PROMPT, user);
  const parsed = parseAnswer(out.raw);
  return { answer: parsed.answer, slides: parsed.slides, model: out.model, label: p.label, ms: Date.now() - t0 };
}

// ---- streaming tutor chat ----
const CHAT_SYSTEM =
  'You are an expert tutor for the German university database course "DSCB140 - Datenbanken & Datenkunde". ' +
  'Answer using ONLY the provided slide excerpts (some may also be given as images), in the SAME language ' +
  'as the question. You may also receive a screenshot the student pasted (e.g. an exam question or a diagram) - ' +
  'read it and answer it directly. ' +
  'Match the answer length to what the question genuinely needs - no more, no less. ' +
  'For a simple, factual, or multiple-choice question: reply with ONLY the answer - a single short sentence ' +
  '(for multiple choice, just the correct option), and no explanation or justification unless the student ' +
  'asks for it (e.g. "warum", "erklär", "begründe", "wieso", "erläutere"). For a question that genuinely ' +
  'needs more - explain in depth, compare, derive step by step, write non-trivial SQL, or list several ' +
  'things - give a COMPLETE answer using short bullets, numbered steps, or a fenced ```sql block as ' +
  'appropriate, and never cut it off mid-thought. In all cases stay tight: no preamble, no restating the ' +
  'question, no summary or sign-off, no padding. Default to concise; expand only when the content truly ' +
  'requires it. Use **bold** for key terms. Cite the slide you used inline as "(Folie N)" with the global ' +
  'page number from the context. ' +
  'If the slides do not contain the answer, say so in one short sentence. NEVER mention being an AI, a model, ' +
  'or that this text is generated - write as if it were the course\'s own notes. No greetings, no "as an AI".';

// Normalize the browser's neutral message blocks ({type:'text'|'image', ...}) to each
// provider's wire format. Plain-string content is passed through untouched.
function toClaudeMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === "string" || !Array.isArray(m.content)) return m;
    return { role: m.role, content: m.content.map((b) =>
      b && b.type === "image"
        ? { type: "image", source: { type: "base64", media_type: b.media_type || "image/png", data: b.data } }
        : { type: "text", text: (b && b.text) || "" }) };
  });
}
function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === "string" || !Array.isArray(m.content)) return m;
    return { role: m.role, content: m.content.map((b) =>
      b && b.type === "image"
        ? { type: "image_url", image_url: { url: "data:" + (b.media_type || "image/png") + ";base64," + b.data } }
        : { type: "text", text: (b && b.text) || "" }) };
  });
}

const FIRST_TOKEN_MS = 22000; // abort an attempt that produces no token in time -> fall back
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamAnthropic(p, key, messages, write, signal) {
  let Anthropic;
  try { Anthropic = require("@anthropic-ai/sdk"); }
  catch (e) { throw Object.assign(new Error("Anthropic SDK missing - npm install @anthropic-ai/sdk"), { status: 500 }); }
  const client = new Anthropic({ apiKey: key });
  const stream = client.messages.stream(
    { model: p.model, max_tokens: 2048, system: CHAT_SYSTEM, messages: toClaudeMessages(messages) },
    { signal, timeout: 120000 }
  );
  stream.on("text", (t) => { try { write(t); } catch (e) {} });
  const fm = await stream.finalMessage();
  if (fm && fm.stop_reason === "max_tokens") { try { write("\n\n… (gekürzt)"); } catch (e) {} }
}

async function streamOpenAICompatible(p, key, messages, write, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(buildOpenAIRequestBody(p, {
          messages: [{ role: "system", content: CHAT_SYSTEM }].concat(toOpenAIMessages(messages)),
          max_tokens: 2048, temperature: 0.3, stream: true,
        })),
        signal,
      });
      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => "");
        const status = resp.status;
        const transient = status === 429 || (status >= 500 && status <= 599);
        const err = Object.assign(new Error(p.label + " error " + status + ": " + t.slice(0, 200)), { status: status === 401 ? 401 : 502 });
        if (transient && attempt === 0) { lastErr = err; await sleep(600); continue; } // one retry on rate-limit/5xx
        throw err;
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") return;
          try {
            const j = JSON.parse(dataStr);
            const tok = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (tok) write(tok);
          } catch (e) { /* keep-alive / partial */ }
        }
      }
      return;
    } catch (e) {
      lastErr = e;
      if (e && e.name === "AbortError") throw e;            // first-token timeout -> let caller fall back
      if (attempt === 0 && !(e && e.status)) { await sleep(600); continue; } // transient network error -> one retry
      throw e;
    }
  }
  throw lastErr || new Error("request failed");
}

function normalizeProvider(name) {
  const r = String(name || "").trim().toLowerCase();
  return PROVIDERS[r] ? r : null;
}

// Try each provider in the chain until one starts streaming tokens. A provider
// that fails BEFORE emitting a token (error, 5xx, or first-token timeout) is
// skipped and the next is tried; once tokens have been written we commit to that
// provider (we can't un-send a partial answer). This is the exam-day safety net.
async function streamWithFallback(payload, res) {
  const messages = payload.messages;
  const chain = providerChainForMessages(messages, normalizeProvider(payload.provider));
  let wrote = false;
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    const p = PROVIDERS[name];
    const key = KEYS[name];
    if (!p || !key) { lastErr = Object.assign(new Error("No API key for " + (p ? p.label : name)), { status: 400 }); continue; }
    const ctrl = new AbortController();
    let got = false;
    const write = (t) => { if (t == null || t === "") return; got = true; wrote = true; clearTimeout(timer); try { res.write(t); } catch (e) {} };
    const timer = setTimeout(() => { if (!got) { try { ctrl.abort(); } catch (e) {} } }, FIRST_TOKEN_MS);
    try {
      console.log("POST /q  try[" + i + "]=" + name + " (" + p.model + ")");
      if (p.kind === "anthropic") await streamAnthropic(p, key, messages, write, ctrl.signal);
      else await streamOpenAICompatible(p, key, messages, write, ctrl.signal);
      clearTimeout(timer);
      return { provider: name };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (wrote) throw e; // already streamed -> cannot fall back to a clean answer
      console.log("  provider " + name + " failed pre-stream: " + (e && e.message) + (i + 1 < chain.length ? " -> fallback" : ""));
    }
  }
  throw lastErr || new Error("all providers failed");
}

// ===================== SQL sandbox (local MySQL bridge) =====================
// Exam-day workflow: the student gets the DB ~5 min before, exports a dump, and
// imports it here. Queries run against the real local MySQL (exam-exact dialect).
// mysql2 is pure-JS and optional — if it's missing or MySQL is unreachable, the
// browser silently falls back to an in-browser SQLite sandbox.
let mysql2Lib = null;
function getMysql() {
  if (mysql2Lib === null) { try { mysql2Lib = require("mysql2/promise"); } catch (e) { mysql2Lib = false; } }
  return mysql2Lib || null;
}
const MYSQL_CFG = (() => {
  const m = (CONFIG && CONFIG.mysql) || {};
  const e = process.env;
  return {
    host: e.MYSQL_HOST || m.host || "127.0.0.1",
    port: parseInt(e.MYSQL_PORT || m.port || 3306, 10) || 3306,
    user: e.MYSQL_USER || m.user || "root",
    password: e.MYSQL_PASSWORD != null ? e.MYSQL_PASSWORD : (m.password != null ? m.password : ""),
    database: e.MYSQL_DATABASE || m.database || "sandbox",
  };
})();
const baseConn = () => ({ host: MYSQL_CFG.host, port: MYSQL_CFG.port, user: MYSQL_CFG.user, password: MYSQL_CFG.password, connectTimeout: 4000 });

// Exam snapshot: a prebuilt SQLite file (from mysql-to-sqlite.js) the app auto-loads.
const SNAPSHOT_PATH = process.env.SLIDEFINDER_SQLITE
  ? path.resolve(process.env.SLIDEFINDER_SQLITE)
  : ((CONFIG && CONFIG.sqliteSnapshot) ? path.resolve(ROOT, CONFIG.sqliteSnapshot) : path.join(ROOT, "data", "exam.sqlite"));

let mysqlPool = null;
function getPool() {
  const lib = getMysql();
  if (!lib) return null;
  if (!mysqlPool) {
    mysqlPool = lib.createPool(Object.assign(baseConn(), {
      database: MYSQL_CFG.database, multipleStatements: true, waitForConnections: true, connectionLimit: 4,
    }));
  }
  return mysqlPool;
}
function resetPool() { if (mysqlPool) { try { mysqlPool.end().catch(() => {}); } catch (e) {} mysqlPool = null; } }

async function mysqlStatus() {
  const lib = getMysql();
  if (!lib) return { available: false, reason: "mysql2 not installed" };
  let conn;
  try {
    conn = await lib.createConnection(baseConn());
    const [[v]] = await conn.query("SELECT VERSION() AS v");
    let tables = [];
    try {
      const [rows] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?", [MYSQL_CFG.database]);
      tables = rows.map((r) => r.t);
    } catch (e) {}
    return { available: true, version: v.v, database: MYSQL_CFG.database, tables };
  } catch (e) {
    return { available: false, reason: (e && (e.code || e.message)) || "connect failed" };
  } finally { try { if (conn) await conn.end(); } catch (e) {} }
}

async function mysqlSchema(conn) {
  const db = MYSQL_CFG.database;
  const runner = conn || getPool();
  if (!runner) throw Object.assign(new Error("mysql2 not installed"), { status: 500 });
  const [rows] = await runner.query(
    "SELECT table_name AS t, column_name AS c, column_type AS ty FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position", [db]);
  const map = new Map();
  for (const r of rows) { if (!map.has(r.t)) map.set(r.t, []); map.get(r.t).push({ name: r.c, type: r.ty }); }
  return [...map.entries()].map(([name, columns]) => ({ name, columns }));
}

async function mysqlImport(dumpText) {
  const lib = getMysql();
  if (!lib) throw Object.assign(new Error("mysql2 not installed"), { status: 500 });
  const conn = await lib.createConnection(Object.assign(baseConn(), { multipleStatements: true }));
  const db = MYSQL_CFG.database;
  try {
    await conn.query("DROP DATABASE IF EXISTS `" + db + "`");
    await conn.query("CREATE DATABASE `" + db + "` CHARACTER SET utf8mb4");
    await conn.query("USE `" + db + "`");
    const cleaned = SqlUtil.stripDbStatements(dumpText);
    try {
      if (cleaned.trim()) await conn.query(cleaned); // fast path: one multi-statement batch
    } catch (batchErr) {
      // precise path: run statement-by-statement so we can name the offender
      const stmts = SqlUtil.splitStatements(dumpText).filter((st) =>
        !/^(CREATE\s+DATABASE|CREATE\s+SCHEMA|DROP\s+DATABASE|DROP\s+SCHEMA|USE|SET|LOCK\s+TABLES|UNLOCK\s+TABLES|\/\*)/i.test(st));
      for (const st of stmts) {
        try { await conn.query(st); }
        catch (e2) { throw Object.assign(new Error("SQL-Import fehlgeschlagen bei: " + st.slice(0, 90).replace(/\s+/g, " ") + " … → " + e2.message), { status: 400 }); }
      }
    }
    const schema = await mysqlSchema(conn);
    const [counts] = await conn.query("SELECT table_name AS t, table_rows AS r FROM information_schema.tables WHERE table_schema = ?", [db]);
    const rowMap = new Map(counts.map((r) => [r.t, Number(r.r) || 0]));
    return { engine: "mysql", database: db, tables: schema.map((t) => ({ name: t.name, rows: rowMap.get(t.name) || 0, columns: t.columns })) };
  } finally { try { await conn.end(); } catch (e) {} resetPool(); }
}

async function mysqlQuery(sql) {
  const pool = getPool();
  if (!pool) throw Object.assign(new Error("mysql2 not installed"), { status: 500 });
  const stmts = SqlUtil.splitStatements(sql);
  if (!stmts.length) return { engine: "mysql", sets: [] };
  const conn = await pool.getConnection();
  const sets = [];
  try {
    for (const st of stmts) {
      const [res, fields] = await conn.query(st);
      if (Array.isArray(res)) {
        const columns = fields && fields.length ? fields.map((f) => f.name) : (res[0] ? Object.keys(res[0]) : []);
        sets.push({ columns, rows: res.map((r) => columns.map((c) => normalizeCell(r[c]))), rowCount: res.length });
      } else {
        sets.push({ columns: ["Ergebnis"], rows: [["OK · " + (res.affectedRows != null ? res.affectedRows + " Zeile(n) betroffen" : "ausgeführt")]], rowCount: 0 });
      }
    }
    return { engine: "mysql", sets };
  } finally { conn.release(); }
}
function normalizeCell(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split("?")[0]); }
  catch { urlPath = req.url.split("?")[0]; }
  if (urlPath === "/") urlPath = "/index.html";

  // Disguised lecture endpoint: /lec/<n> streams vl<n>.pdf as text/plain so
  // download managers (IDM etc.) don't intercept it as a PDF download. The app
  // fetches these bytes and renders them from an in-memory blob.
  const lec = /^\/lec\/(\d+)$/.exec(urlPath);
  if (lec) {
    if (!allowMethods(req, res, ["GET", "HEAD"])) return;
    const fp = path.join(ROOT, "assets", "lectures", "vl" + lec[1] + ".pdf");
    return fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); console.log("404 lec", lec[1]); return res.end("no lecture"); }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=x-user-defined",
        "Content-Length": st.size,
        "Cache-Control": "no-cache",
      });
      console.log("GET /lec/" + lec[1] + " -> 200 (" + st.size + " bytes, text/plain)");
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(fp).on("error", () => { try { res.destroy(); } catch {} }).pipe(res);
    });
  }

  // LLM proxy: browser POSTs {question, provider, candidates}; we call the model.
  if (urlPath === "/llm") {
    if (!allowMethods(req, res, ["POST"])) return;
    readJsonBody(req, res, 4e6, async (payload) => {
      const { question, candidates } = payload || {};
      if (!question || !Array.isArray(candidates)) return sendJson(res, 400, { error: "Missing question or candidates" });
      console.log("POST /llm  provider=glm  candidates=" + candidates.length);
      try {
        const result = await askLLM(String(question), candidates);
        sendJson(res, 200, result);
      } catch (e) {
        console.log("LLM error:", e && e.message);
        sendJson(res, e && e.status ? e.status : 500, { error: (e && e.message) || "LLM request failed" });
      }
    });
    return;
  }

  // streaming tutor chat: browser POSTs {provider, messages}; we stream tokens back
  if (urlPath === "/q") {
    if (!allowMethods(req, res, ["POST"])) return;
    readJsonBody(req, res, 30e6, async (payload) => {
      const messages = payload && payload.messages;
      if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { error: "Missing messages" });
      const chain = providerChainForMessages(messages, normalizeProvider(payload && payload.provider));
      const usable = chain.find((n) => KEYS[n]);
      if (!usable) {
        const need = PROVIDERS[chain[0]] || PROVIDERS.glm;
        return sendJson(res, 400, { error: "No API key for " + need.label + ". Set " + need.envHint + " or add it to serve.config.json, then restart the server." });
      }
      console.log("POST /q  chain=[" + chain.join(",") + "]  image=" + messagesContainImage(messages) + "  turns=" + messages.length);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      try {
        await streamWithFallback(payload, res);
      } catch (e) {
        console.log("stream error:", e && e.message);
        try { res.write("\n\n_(Fehler: " + ((e && e.message) || "stream failed") + ")_"); } catch (e2) {}
      }
      try { res.end(); } catch (e) {}
    });
    return;
  }

  // SQL sandbox: status probe + query + dump import against the local MySQL.
  if (urlPath === "/sql/status") {
    if (!allowMethods(req, res, ["GET", "HEAD"])) return;
    if (req.method === "HEAD") { res.writeHead(200); return res.end(); }
    return mysqlStatus().then((s) => sendJson(res, 200, s)).catch((e) => sendJson(res, 200, { available: false, reason: (e && e.message) || "error" }));
  }
  if (urlPath === "/sql/filestatus") {
    if (!allowMethods(req, res, ["GET", "HEAD"])) return;
    return fs.stat(SNAPSHOT_PATH, (err, st) => {
      if (err || !st.isFile()) return sendJson(res, 200, { exists: false });
      sendJson(res, 200, { exists: true, size: st.size, name: path.basename(SNAPSHOT_PATH), mtime: st.mtimeMs });
    });
  }
  if (urlPath === "/sql/file") {
    if (!allowMethods(req, res, ["GET", "HEAD"])) return;
    return fs.stat(SNAPSHOT_PATH, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end("no snapshot"); }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-store" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(SNAPSHOT_PATH).on("error", () => { try { res.destroy(); } catch (e) {} }).pipe(res);
    });
  }
  if (urlPath === "/sql/schema") {
    if (!allowMethods(req, res, ["GET", "HEAD"])) return;
    if (req.method === "HEAD") { res.writeHead(200); return res.end(); }
    return mysqlSchema().then((tables) => sendJson(res, 200, { engine: "mysql", database: MYSQL_CFG.database, tables }))
      .catch((e) => sendJson(res, 200, { engine: "mysql", database: MYSQL_CFG.database, tables: [], error: (e && e.message) || "schema unavailable" }));
  }
  if (urlPath === "/sql/query") {
    if (!allowMethods(req, res, ["POST"])) return;
    readJsonBody(req, res, 4e6, async (payload) => {
      const sql = payload && payload.sql;
      if (!sql || typeof sql !== "string") return sendJson(res, 400, { error: "Missing sql" });
      try { const out = await mysqlQuery(sql); sendJson(res, 200, out); }
      catch (e) { console.log("SQL query error:", e && e.message); sendJson(res, (e && e.status) || 502, { error: (e && e.message) || "query failed" }); }
    });
    return;
  }
  if (urlPath === "/sql/import") {
    if (!allowMethods(req, res, ["POST"])) return;
    readJsonBody(req, res, 80e6, async (payload) => {
      const sql = payload && payload.sql;
      if (!sql || typeof sql !== "string") return sendJson(res, 400, { error: "Missing sql" });
      console.log("POST /sql/import  bytes=" + sql.length);
      try { const out = await mysqlImport(sql); console.log("  imported " + out.tables.length + " tables into " + out.database); sendJson(res, 200, out); }
      catch (e) { console.log("SQL import error:", e && e.message); sendJson(res, (e && e.status) || 502, { error: (e && e.message) || "import failed" }); }
    });
    return;
  }

  if (!allowMethods(req, res, ["GET", "HEAD"])) return;
  const safe = path.normalize(urlPath).replace(/^([/\\])+/, "");
  const filePath = path.resolve(ROOT, safe);
  if (!insideRoot(filePath)) return sendText(res, 403, "Forbidden");
  const blocked = staticBlock(filePath);
  if (blocked) return sendText(res, blocked.code, blocked.text);

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); console.log("404", urlPath); return res.end("Not found: " + urlPath); }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    const tag = `${req.method} ${urlPath}${range ? " [" + range + "]" : ""}`;
    let sent = 0;
    res.on("close", () => console.log(`${tag} -> ${res.statusCode} sent=${sent}/${st.size}${res.writableFinished ? "" : " ABORTED"}`));

    const onErr = (e) => { console.log(`${tag} STREAM ERROR ${e && e.message}`); try { res.destroy(); } catch {} };
    const count = (s) => s.on("data", (c) => (sent += c.length));

    if (range) {
      const parsed = parseByteRange(range, st.size);
      if (!parsed) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      const { start, end } = parsed;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") return res.end();
      count(fs.createReadStream(filePath, { start, end }).on("error", onErr)).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": st.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") return res.end();
      count(fs.createReadStream(filePath).on("error", onErr)).pipe(res);
    }
  });
});

server.on("clientError", (err, socket) => { try { socket.destroy(); } catch {} });
server.listen(PORT, () => {
  console.log(`DB Slide Finder  ->  http://localhost:${PORT}`);
  console.log(`serving ${ROOT}`);
  console.log("LLM keys present: glm=" + !!KEYS.glm + " sonnet/haiku=" + !!KEYS.sonnet);
  mysqlStatus().then((s) => {
    if (s.available) console.log("SQL sandbox: MySQL " + s.version + " reachable (db '" + s.database + "', " + (s.tables ? s.tables.length : 0) + " tables) — exam-exact path ready");
    else console.log("SQL sandbox: MySQL not reachable (" + s.reason + ") — browser SQLite fallback will be used");
    try { const st = fs.statSync(SNAPSHOT_PATH); console.log("SQL snapshot: " + path.basename(SNAPSHOT_PATH) + " present (" + Math.round(st.size / 1024) + " KB) — app auto-loads it"); }
    catch (e) { console.log("SQL snapshot: none yet — run `node mysql-to-sqlite.js --database <db>` to create " + path.relative(ROOT, SNAPSHOT_PATH)); }
  }).catch(() => {});
  console.log("(Ctrl+C to stop)");
});
