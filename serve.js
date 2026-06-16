/* Robust static file server for DB Slide Finder.
 * Node's http + streaming handles the 14 MB PDF reliably (Python's
 * http.server drops/empties large files on Windows). Run: node serve.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

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
const KEYS = {
  codex: process.env.ANTHROPIC_API_KEY || CONFIG.anthropicApiKey || "",
  sonnet: process.env.ANTHROPIC_API_KEY || CONFIG.anthropicApiKey || "",
  grok: process.env.XAI_API_KEY || CONFIG.xaiApiKey || "",
  deepseek: process.env.DEEPSEEK_API_KEY || CONFIG.deepseekApiKey || "",
};
const M = CONFIG.models || {};
const PROVIDERS = {
  codex:    { label: "Codex (Haiku 4.5)", model: M.codex || M.claude || "claude-haiku-4-5", kind: "anthropic", envHint: "ANTHROPIC_API_KEY" },
  sonnet:   { label: "Sonnet 4.6", model: M.sonnet || "claude-sonnet-4-6", kind: "anthropic", envHint: "ANTHROPIC_API_KEY" },
  grok:     { label: "Grok 4.3", model: M.grok || "grok-4.3", kind: "openai", url: "https://api.x.ai/v1/chat/completions", envHint: "XAI_API_KEY" },
  deepseek: { label: "DeepSeek V4", model: M.deepseek || "deepseek-chat", kind: "openai", url: "https://api.deepseek.com/v1/chat/completions", envHint: "DEEPSEEK_API_KEY" },
};
const PROVIDER_ALIASES = { claude: "codex", haiku: "codex" };
function normalizeProvider(provider) {
  const raw = String(provider || "codex").trim().toLowerCase();
  return PROVIDER_ALIASES[raw] || raw;
}

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
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: 1024,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
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

async function askLLM(provider, question, candidates) {
  provider = normalizeProvider(provider);
  const p = PROVIDERS[provider];
  if (!p) { const e = new Error("Unknown provider: " + provider); e.status = 400; throw e; }
  const key = KEYS[provider];
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

async function streamAnthropic(p, key, messages, res) {
  let Anthropic;
  try { Anthropic = require("@anthropic-ai/sdk"); }
  catch (e) { throw Object.assign(new Error("Anthropic SDK missing - npm install @anthropic-ai/sdk"), { status: 500 }); }
  const client = new Anthropic({ apiKey: key });
  const stream = client.messages.stream({ model: p.model, max_tokens: 2048, system: CHAT_SYSTEM, messages: toClaudeMessages(messages) });
  stream.on("text", (t) => { try { res.write(t); } catch (e) {} });
  const fm = await stream.finalMessage();
  if (fm && fm.stop_reason === "max_tokens") { try { res.write("\n\n… (gekürzt)"); } catch (e) {} }
}

async function streamOpenAICompatible(p, key, messages, res) {
  const resp = await fetch(p.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: "system", content: CHAT_SYSTEM }].concat(toOpenAIMessages(messages)),
      max_tokens: 2048, temperature: 0.3, stream: true,
    }),
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

async function streamChat(provider, messages, res) {
  provider = normalizeProvider(provider);
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error("Unknown provider"), { status: 400 });
  const key = KEYS[provider];
  if (!key) throw Object.assign(new Error("No API key for " + p.label + ". Set " + p.envHint + " or add it to serve.config.json, then restart."), { status: 400 });
  if (p.kind === "anthropic") return streamAnthropic(p, key, messages, res);
  return streamOpenAICompatible(p, key, messages, res);
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
      const { question, provider, candidates } = payload || {};
      if (!question || !Array.isArray(candidates)) return sendJson(res, 400, { error: "Missing question or candidates" });
      console.log("POST /llm  provider=" + provider + "  candidates=" + candidates.length);
      try {
        const result = await askLLM(provider || "codex", String(question), candidates);
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
      const provider = normalizeProvider((payload && payload.provider) || "codex");
      const messages = payload && payload.messages;
      if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { error: "Missing messages" });
      const p = PROVIDERS[provider];
      if (!p) return sendJson(res, 400, { error: "Unknown provider: " + provider });
      if (!KEYS[provider]) return sendJson(res, 400, { error: "No API key for " + p.label + ". Set " + p.envHint + " or add it to serve.config.json, then restart the server." });
      console.log("POST /q  provider=" + provider + "  turns=" + messages.length);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      try {
        await streamChat(provider, messages, res);
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
  console.log("LLM keys present: codex=" + !!KEYS.codex + " sonnet=" + !!KEYS.sonnet + " grok=" + !!KEYS.grok + " deepseek=" + !!KEYS.deepseek);
  console.log("(Ctrl+C to stop)");
});
