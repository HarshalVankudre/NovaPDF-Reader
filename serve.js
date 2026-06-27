/* Robust static file server for DB Slide Finder.
 * Node's http + streaming handles the 14 MB PDF reliably (Python's
 * http.server drops/empties large files on Windows). Run: node serve.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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
  ".map": "application/json",
};

// ---- caching + compression -------------------------------------------------
// Text assets are gzipped; everything carries a validator so the browser can
// revalidate cheaply (304) instead of re-downloading. Vendored libs and the
// immutable PDFs cache hard; source files revalidate so edits show on refresh.
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);
function cacheControlFor(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf" || base === "pdf.min.js" || base === "pdf.worker.min.js") {
    // 30 days — vendored / immutable content. Not "immutable": kept revalidatable
    // so an explicit reload still picks up a replaced file via its ETag.
    return "public, max-age=2592000";
  }
  return "no-cache"; // index.html, app.js, search-engine.js, style.css, slides.json
}
function etagFor(st, gzip) {
  return '"' + st.size.toString(16) + "-" + Math.floor(st.mtimeMs).toString(16) + (gzip ? "-gz" : "") + '"';
}
// encodingSensitive: for a `Vary: Accept-Encoding` (compressible) response, an
// If-Modified-Since alone can't tell gzip from identity, so only trust the ETag.
function notModified(req, etag, lastModified, encodingSensitive) {
  const inm = req.headers["if-none-match"];
  if (inm) return inm.split(",").some((t) => { t = t.trim().replace(/^W\//, ""); return t === etag || t === "*"; });
  if (encodingSensitive) return false;
  const ims = req.headers["if-modified-since"];
  if (ims && lastModified) {
    const since = Date.parse(ims);
    return !Number.isNaN(since) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

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
function loadConfig() {
  try {
    const p = path.join(ROOT, "serve.config.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { console.warn("serve.config.json parse error:", e.message); }
  return {};
}
const CONFIG = loadConfig();
const M = CONFIG.models || {};
// Single AI provider: Qwen 3.5 Flash (reasoning disabled) via OpenRouter. The browser
// never sees the key — it POSTs to /q (or /llm) and this server calls OpenRouter.
const API_KEY = process.env.OPENROUTER_API_KEY || CONFIG.openrouterApiKey || "";
const TUTOR = {
  label: "Qwen 3.5 Flash",
  model: M.tutor || M.grok || "qwen/qwen3.5-flash-02-23",
  url: process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions",
  envHint: "OPENROUTER_API_KEY",
  params: { reasoning: { effort: "none" } },
  headers: { "HTTP-Referer": "http://localhost:" + PORT, "X-Title": "Notizen" },
};

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

async function askOpenAICompatible(p, key, system, user) {
  const resp = await fetch(p.url, {
    method: "POST",
    headers: Object.assign({ Authorization: "Bearer " + key, "Content-Type": "application/json" }, p.headers || {}),
    body: JSON.stringify(Object.assign({
      model: p.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: 1024,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }, p.params || {})),
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
  if (!API_KEY) {
    const e = new Error("No API key for " + TUTOR.label + ". Set " + TUTOR.envHint + " (environment variable) or add it to serve.config.json, then restart the server.");
    e.status = 400; throw e;
  }
  const user = buildUserPrompt(question, candidates);
  const t0 = Date.now();
  const out = await askOpenAICompatible(TUTOR, API_KEY, SYSTEM_PROMPT, user);
  const parsed = parseAnswer(out.raw);
  return { answer: parsed.answer, slides: parsed.slides, model: out.model, label: TUTOR.label, ms: Date.now() - t0 };
}

// ---- streaming tutor chat ----
const CHAT_SYSTEM =
  'You are an expert tutor for the German university database course "DSCB140 - Datenbanken & Datenkunde". ' +
  'Answer the student\'s question directly in the SAME language as the question. You may receive a screenshot ' +
  'the student pasted (e.g. an exam question or a diagram) - read it and answer it directly. ' +
  'For greetings or casual conversation, respond naturally and briefly. ' +
  'Match the answer length to what the question genuinely needs - no more, no less. ' +
  'For a simple, factual, or multiple-choice question: reply with ONLY the answer - a single short sentence ' +
  '(for multiple choice, just the correct option), and no explanation or justification unless the student ' +
  'asks for it (e.g. "warum", "erklär", "begründe", "wieso", "erläutere"). For a question that genuinely ' +
  'needs more - explain in depth, compare, derive step by step, write non-trivial SQL, or list several ' +
  'things - give a COMPLETE answer using short bullets, numbered steps, or a fenced ```sql block as ' +
  'appropriate, and never cut it off mid-thought. In all cases stay tight: no preamble, no restating the ' +
  'question, no summary or sign-off, no padding. Default to concise; expand only when the content truly ' +
  'requires it. Use **bold** for key terms. NEVER mention being an AI, a model, or that this text is generated - ' +
  'write as if it were the course\'s own notes. For substantive questions, do not add a greeting or preamble. ' +
  'Never say "as an AI".';

// Normalize the browser's neutral message blocks ({type:'text'|'image', ...}) to
// OpenAI's wire format. Plain-string content is passed through untouched.
function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === "string" || !Array.isArray(m.content)) return m;
    return { role: m.role, content: m.content.map((b) =>
      b && b.type === "image"
        ? { type: "image_url", image_url: { url: "data:" + (b.media_type || "image/png") + ";base64," + b.data } }
        : { type: "text", text: (b && b.text) || "" }) };
  });
}

async function streamOpenAICompatible(p, key, messages, res) {
  const resp = await fetch(p.url, {
    method: "POST",
    headers: Object.assign({ Authorization: "Bearer " + key, "Content-Type": "application/json" }, p.headers || {}),
    body: JSON.stringify(Object.assign({
      model: p.model,
      messages: [{ role: "system", content: CHAT_SYSTEM }].concat(toOpenAIMessages(messages)),
      max_tokens: 2048, temperature: 0.3,
    }, p.params || {}, { stream: true })),
  });
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(p.label + " error " + resp.status + ": " + t.slice(0, 200)), { status: resp.status === 401 ? 401 : 502 });
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
        if (tok) res.write(tok);
      } catch (e) { /* keep-alive / partial */ }
    }
  }
}

async function streamChat(messages, res) {
  if (!API_KEY) throw Object.assign(new Error("No API key for " + TUTOR.label + ". Set " + TUTOR.envHint + " or add it to serve.config.json, then restart."), { status: 400 });
  return streamOpenAICompatible(TUTOR, API_KEY, messages, res);
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
      // Lecture PDFs rarely change → cache hard so re-opening a lecture is instant,
      // but keep them revalidatable (ETag) so a rebuilt PDF is picked up on reload.
      const lastModified = st.mtime;
      const etag = etagFor(st, false);
      if (notModified(req, etag, lastModified)) {
        res.writeHead(304, { ETag: etag, "Last-Modified": lastModified.toUTCString(), "Cache-Control": "public, max-age=2592000" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=x-user-defined",
        "Content-Length": st.size,
        "Cache-Control": "public, max-age=2592000",
        ETag: etag,
        "Last-Modified": lastModified.toUTCString(),
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
      console.log("POST /llm  candidates=" + candidates.length);
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
      if (!API_KEY) return sendJson(res, 400, { error: "No API key for " + TUTOR.label + ". Set " + TUTOR.envHint + " or add it to serve.config.json, then restart the server." });
      console.log("POST /q  turns=" + messages.length);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      try {
        await streamChat(messages, res);
      } catch (e) {
        console.log("stream error:", e && e.message);
        try { res.write("\n\n_(Fehler: " + ((e && e.message) || "stream failed") + ")_"); } catch (e2) {}
      }
      try { res.end(); } catch (e) {}
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
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;
    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const willGzip = !range && acceptsGzip && COMPRESSIBLE.has(ext) && st.size > 0;
    const cacheControl = cacheControlFor(filePath);
    const lastModified = st.mtime;
    const etag = etagFor(st, willGzip);

    // Unchanged since the client's cached copy → 304, no body. (Range requests
    // keep their own conditional semantics; revalidate those the normal way.)
    if (!range && notModified(req, etag, lastModified, COMPRESSIBLE.has(ext))) {
      res.writeHead(304, { ETag: etag, "Last-Modified": lastModified.toUTCString(), "Cache-Control": cacheControl, Vary: "Accept-Encoding" });
      return res.end();
    }

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
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": lastModified.toUTCString(),
      });
      if (req.method === "HEAD") return res.end();
      count(fs.createReadStream(filePath, { start, end }).on("error", onErr)).pipe(res);
    } else if (willGzip) {
      // Compressed text asset: stream through gzip (chunked, no Content-Length).
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Encoding": "gzip",
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": lastModified.toUTCString(),
        Vary: "Accept-Encoding",
      });
      if (req.method === "HEAD") return res.end();
      const gz = zlib.createGzip();
      gz.on("error", onErr);
      count(fs.createReadStream(filePath).on("error", onErr)).pipe(gz).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": st.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": lastModified.toUTCString(),
        Vary: "Accept-Encoding",
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
  console.log("LLM key present (Qwen 3.5 Flash via OpenRouter): " + !!API_KEY);
  console.log("(Ctrl+C to stop)");
});
