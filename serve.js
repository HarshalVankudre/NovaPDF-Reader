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
  REASONING_EFFORTS,
  modelChoicesFromApi,
} = require("./llm-config");

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

// Static-file ETags are size+mtime. Vercel bundles may not preserve mtimes,
// so there the deployment id is mixed in (a new deploy never matches old tags).
const ETAG_SALT = process.env.VERCEL
  ? String(process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || Date.now().toString(36)).slice(0, 16) + "-"
  : "";
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (t) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => bare(t) === bare(etag));
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

const ANSWER_FORMAT_RULES =
  'Follow the current request\'s explicit answer format before choosing a layout. Preserve its labels, ' +
  'numbering, order, item count, table columns, units and requested precision. The requested format takes ' +
  'priority over default Markdown and source annotations.\n' +
  'If it asks for only a number, word, option letters, code, JSON or CSV, return that payload alone. ' +
  'JSON must be valid JSON; raw code and CSV stay raw when requested. Add no wrapper, heading, citation ' +
  'or explanation to an exact-format answer.\n' +
  'For multiple choice, give all correct option labels; include option text only if requested or labels ' +
  'are absent. For true/false, give one verdict per statement. For calculations, give the result with ' +
  'the appropriate units and precision. Give reasons, derivations or examples when the task asks for them.\n' +
  'Answer every requested part in order, including every item when a count is specified. Keep explanations ' +
  'as short as the task permits while retaining required steps, conditions and qualifications.\n' +
  'When no format is specified, use the shortest complete answer in the question\'s language. Start with ' +
  'the answer itself and stop when the task is answered. Omit introductions, question restatements, ' +
  'unrequested background, study advice, recaps and follow-up offers.\n' +
  'Before sending, silently check correctness, coverage of every part, and compliance with the requested format.';

const SYSTEM_PROMPT =
  'You are a precise study assistant for the German university database course ' +
  '"DSCB140 - Datenbanken & Datenkunde". You receive a student QUESTION and several candidate ' +
  'lecture SLIDES (each with a global page number, its lecture, a title, and extracted text). ' +
  'Identify which slide(s) best answer the question, then write the answer GROUNDED ' +
  'only in those slides. Apply the following answer rules to the answer field, preserving the outer JSON ' +
  'envelope used by the app:\n' + ANSWER_FORMAT_RULES + '\n' +
  'If none of the slides answer it, say so in a few words and use an empty slides list. Return a JSON object ' +
  '(no markdown, no code fences) of the exact ' +
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
    // Fable 5 always thinks and thinking counts toward max_tokens — 1024 could
    // be eaten by reasoning alone, truncating the visible JSON answer.
    max_tokens: 4096,
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
  const p = PROVIDERS.opus;
  const key = KEYS.opus;
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
// Written for Fable 5: it follows the system prompt closely, so rules are
// stated once, at normal volume, with the reason beside them (shouted
// MUST/NEVER rules over-apply on current models). The stealth constraint
// (never mention being an AI / generated text) is load-bearing.
const CHAT_SYSTEM =
  'You write the course notes ("Notizen") for the German university database course ' +
  '"DSCB140 - Datenbanken & Datenkunde" (lectures VL1-VL7, 317 slides with global slide numbers). ' +
  'The reader is a student working through tasks from this course who reads the answer straight off the ' +
  'screen, so an answer has to be complete, correct and quick to scan.\n' +
  '\n' +
  'A question may come with slide excerpts as text, the most relevant slides as images (each labeled ' +
  '"Bild von Folie N"), a pasted task screenshot, and attached text files. ' +
  'Every question stands alone - there is no conversation - so each answer ' +
  'is self-contained and never refers to earlier notes or answers.\n' +
  '\n' +
  'Answer contract\n' + ANSWER_FORMAT_RULES + '\n' +
  '\n' +
  'Solving the task\n' +
  'The typed or pasted task (text or screenshot) is the subject; the slides are reference material. ' +
  'Ground the answer in the provided material where it covers the task. ER diagrams, cardinalities, table ' +
  'contents and SQL on the slide images are often missing from the extracted text, so read the images. Copy ' +
  'names, numbers and terminology character-exactly from the source and use the German terms the slides use, ' +
  'since that is the vocabulary the course expects. Check the places where answers to these tasks typically go ' +
  'wrong: every option of a multiple-choice question (several can be correct), both directions of a ' +
  'relationship for cardinalities and (min,max) notation, the normal-form definitions against the given ' +
  'attributes and dependencies, and any arithmetic.\n' +
  'If the material does not cover a general knowledge question, use established knowledge. If a required ' +
  'value, diagram or passage is missing or unreadable, use the requested format\'s unknown/null form when ' +
  'available; otherwise identify the missing information in one short sentence instead of inventing an answer.\n' +
  '\n' +
  'Sources\n' +
  'For ordinary prose answers, end with "(Folie N)" or "(Folie N, M)" using only provided slides that support ' +
  'the answer. The app checks these citations, so cite no slide that was not supplied. Use "(allg.)" for ' +
  'general knowledge instead. Omit source annotations when they would break a requested format, such as ' +
  'an answer-only result, a table-only answer, code, JSON or CSV. Screenshot tasks need no citation.\n' +
  '\n' +
  'This is a notes document: never mention being an AI or a model, or that the text is generated.';

// Normalize the browser's neutral message blocks ({type:'text'|'image', ...}) to
// each provider's wire format. Plain-string content is passed through untouched.
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

// Adaptive thinking is on, so the model decides how much to reason internally
// before any visible text — on a hard multi-part task at high effort the first
// TEXT token can take minutes. So there is no deadline for the first text;
// instead an attempt is aborted only when the upstream stream goes silent:
// thinking progress (summarized thinking deltas, never forwarded) counts as
// activity. Depth is set by REASONING_EFFORT, not a token budget
// (budget_tokens is removed on Fable 5/Opus 4.8; adaptive thinking + effort replaces it).
const STALL_MS = 120000;            // abort when no stream event (text or thinking progress) arrives for this long
const REASONING_EFFORT = "high";    // default adaptive-thinking depth: low | medium | high | xhigh | max — "high" = quality over speed/cost (exam day)
// Fable 5's safety classifiers can (rarely) decline a request with
// stop_reason "refusal" instead of an HTTP error. The server-side fallback
// re-runs the same request on Opus 4.8 inside the same call, so the tutor
// still answers. Only wired up for Fable/Mythos models — an Opus model set
// via the models.opus config override streams plain, without the beta.
const FABLE_FALLBACK_MODEL = "claude-opus-4-8";
const FABLE_FALLBACK_BETA = "server-side-fallback-2026-06-01";
const isFableModel = (m) => /fable|mythos/i.test(String(m || ""));
// The client may override effort per request (whitelisted): ":fast" answers run
// at "medium" for latency; the cross-check arbiter runs at "xhigh" for depth.
const EFFORTS = new Set(REASONING_EFFORTS);
function normalizeEffort(e) {
  e = String(e || "").toLowerCase();
  return EFFORTS.has(e) ? e : REASONING_EFFORT;
}

let modelCatalog = null, modelCatalogUntil = 0, modelCatalogPending = null;
function defaultModelChoice() {
  return { id: PROVIDERS.opus.model, label: PROVIDERS.opus.label, efforts: REASONING_EFFORTS, maxTokens: 64000 };
}
async function getModelCatalog() {
  if (modelCatalog && Date.now() < modelCatalogUntil) return modelCatalog;
  if (!KEYS.opus) return [defaultModelChoice()];
  if (!modelCatalogPending) {
    modelCatalogPending = (async () => {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: KEYS.opus, timeout: 10000, maxRetries: 0 });
      const records = [];
      for await (const model of client.models.list({ limit: 100 })) records.push(model);
      const choices = modelChoicesFromApi(records);
      if (!choices.some((model) => model.id === PROVIDERS.opus.model)) choices.unshift(defaultModelChoice());
      modelCatalog = choices;
      modelCatalogUntil = Date.now() + 15 * 60 * 1000;
      return choices;
    })().finally(() => { modelCatalogPending = null; });
  }
  return modelCatalogPending;
}
async function resolveModelChoice(requested) {
  if (requested == null || requested === "" || requested === PROVIDERS.opus.model) {
    return (modelCatalog || []).find((model) => model.id === PROVIDERS.opus.model) || defaultModelChoice();
  }
  if (typeof requested !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(requested)) {
    throw Object.assign(new Error("Ungültiges Modell."), { status: 400 });
  }
  const model = (await getModelCatalog()).find((choice) => choice.id === requested);
  if (!model) throw Object.assign(new Error("Modell nicht verfügbar. Bitte in den Einstellungen neu auswählen."), { status: 400 });
  return model;
}
function effortForModel(effort, model) {
  const supported = model.efforts;
  for (let i = REASONING_EFFORTS.indexOf(effort); i >= 0; i--) {
    if (supported.includes(REASONING_EFFORTS[i])) return REASONING_EFFORTS[i];
  }
  return supported[0];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamAnthropic(p, key, messages, write, signal, effort, onActivity) {
  let Anthropic;
  try { Anthropic = require("@anthropic-ai/sdk"); }
  catch (e) { throw Object.assign(new Error("Anthropic SDK missing - npm install @anthropic-ai/sdk"), { status: 500 }); }
  const client = new Anthropic({ apiKey: key });
  // NOTE: do not add temperature/top_p/top_k — Fable 5 (and Opus 4.8) reject
  // non-default sampling params with a 400. Precision is steered via
  // CHAT_SYSTEM + effort. thinking:{type:"adaptive"} is accepted on both
  // (on Fable 5 thinking is always on anyway; never send {type:"disabled"}).
  const params = {
    model: p.model,
    max_tokens: p.maxTokens || 64000,               // leave room for thinking within the selected model's output limit
    // "adaptive" is explicit on purpose — an Opus model via the models.opus
    // override would otherwise run without thinking. "summarized" makes the
    // stream carry thinking progress, which the stall detector uses as a
    // liveness signal (same thinking, same billing; the text is never sent on).
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: effort || REASONING_EFFORT }, // how deeply it reasons before answering
    system: CHAT_SYSTEM,
    messages: toClaudeMessages(messages),
  };
  const opts = { signal, timeout: 300000 };
  // Fable 5: opt into the server-side refusal fallback (beta) so a classifier
  // decline is transparently re-served by Opus 4.8 on the same stream.
  const stream = isFableModel(p.model)
    ? client.beta.messages.stream(
        Object.assign({}, params, {
          betas: [FABLE_FALLBACK_BETA],
          fallbacks: [{ model: FABLE_FALLBACK_MODEL }],
        }),
        opts
      )
    : client.messages.stream(params, opts);
  // only the visible answer is streamed; thinking deltas are never written out
  stream.on("text", (t) => { try { write(t); } catch (e) {} });
  if (onActivity) stream.on("streamEvent", () => onActivity());
  const fm = await stream.finalMessage();
  if (fm && fm.stop_reason === "max_tokens") { try { write("\n\n… (gekürzt)"); } catch (e) {} }
  // whole chain refused (Fable declined AND the Opus fallback declined, or the
  // beta was unavailable) — say so instead of ending on a silent empty answer
  if (fm && fm.stop_reason === "refusal") { try { write("\n\n(Anfrage wurde vom Modell abgelehnt — bitte umformulieren.)"); } catch (e) {} }
}

async function streamOpenAICompatible(p, key, messages, write, signal, onActivity) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(buildOpenAIRequestBody(p, {
          messages: [{ role: "system", content: CHAT_SYSTEM }].concat(toOpenAIMessages(messages)),
          max_tokens: 4096, temperature: 0.3, stream: true,
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
        if (onActivity) onActivity();
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
      if (e && e.name === "AbortError") throw e;            // stall / client abort -> let the caller decide
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

function streamProvider(p, key, messages, write, signal, effort, onActivity) {
  return p.kind === "anthropic"
    ? streamAnthropic(p, key, messages, write, signal, effort, onActivity)
    : streamOpenAICompatible(p, key, messages, write, signal, onActivity);
}

// Worth one more try: rate limits, overload (529 / an SSE overloaded_error,
// which carries no HTTP status) and dropped connections. Never retried: 4xx
// request errors, a stalled stream, and a client that went away.
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
function isTransientError(e) {
  if (!e || e.timedOut || e.clientGone) return false;
  if (e.name === "AbortError" || e.name === "APIUserAbortError") return false;
  return e.status == null || TRANSIENT_STATUS.has(e.status);
}
const RETRY_DELAY_MS = 1500;

// Try each provider in the chain until one starts streaming tokens. A provider
// that fails BEFORE emitting a token is retried once if the failure looks
// transient, then the next provider is tried; once tokens have been written we
// commit (we can't un-send a partial answer). This is the exam-day safety net.
// opts.signal aborts the upstream request when the browser disconnects, so a
// closed tab or a :stop doesn't keep a paid generation running.
async function streamWithFallback(payload, res, opts = {}) {
  const messages = payload.messages;
  const choice = opts.modelChoice || await resolveModelChoice(payload.model);
  const effort = effortForModel(normalizeEffort(payload && payload.effort), choice);
  const chain = providerChainForMessages(messages, normalizeProvider(payload.provider));
  const clientSignal = opts.signal || null;
  const stream = opts.stream || streamProvider;
  const keys = opts.keys || KEYS;
  const stallMs = opts.stallMs || STALL_MS;
  const retryDelayMs = opts.retryDelayMs != null ? opts.retryDelayMs : RETRY_DELAY_MS;
  const clientGone = () => Object.assign(new Error("client disconnected"), { clientGone: true });
  let wrote = false;
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    const p = PROVIDERS[name] && Object.assign({}, PROVIDERS[name], { model: choice.id, label: choice.label, maxTokens: choice.maxTokens });
    const key = keys[name];
    if (!p || !key) { lastErr = Object.assign(new Error("No API key for " + (p ? p.label : name)), { status: 400 }); continue; }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (clientSignal && clientSignal.aborted) throw clientGone();
      const ctrl = new AbortController();
      const onClientAbort = () => { try { ctrl.abort(); } catch (e) {} };
      if (clientSignal) clientSignal.addEventListener("abort", onClientAbort, { once: true });
      // stall detector: re-armed by every upstream event (text, thinking progress)
      let timedOut = false, timer = null;
      const alive = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch (e) {} }, stallMs);
      };
      const write = (t) => { if (t == null || t === "") return; wrote = true; alive(); try { res.write(t); } catch (e) {} };
      alive();
      try {
        console.log("POST /q  try[" + i + (attempt ? "." + attempt : "") + "]=" + name + " (" + p.model + ", effort=" + effort + ")");
        await stream(p, key, messages, write, ctrl.signal, effort, alive);
        return { provider: name };
      } catch (e) {
        if (clientSignal && clientSignal.aborted) throw clientGone();
        if (timedOut) e = Object.assign(new Error("keine Daten seit " + Math.round(stallMs / 1000) + " s — Verbindung abgebrochen"), { timedOut: true });
        lastErr = e;
        if (wrote) throw e; // already streamed -> cannot fall back to a clean answer
        const retry = attempt === 0 && isTransientError(e);
        console.log("  provider " + name + " failed pre-stream: " + (e && e.message) +
          (retry ? " -> retry" : (i + 1 < chain.length ? " -> fallback" : "")));
        if (!retry) break;
        await sleep(retryDelayMs);
      } finally {
        clearTimeout(timer);
        if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
      }
    }
  }
  throw lastErr || new Error("all providers failed");
}

function handleRequest(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split("?")[0]); }
  catch { urlPath = req.url.split("?")[0]; }
  if (urlPath === "/") urlPath = "/index.html";

  if (urlPath === "/prefs") {
    if (!allowMethods(req, res, ["GET"])) return;
    res.setHeader("Cache-Control", "no-store");
    return getModelCatalog().then((models) => sendJson(res, 200, {
      defaultModel: PROVIDERS.opus.model, defaultEffort: REASONING_EFFORT, models,
    })).catch(() => sendJson(res, 503, { error: "Modellliste nicht verfügbar. Bitte erneut versuchen." }));
  }

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
      console.log("POST /llm  provider=opus  candidates=" + candidates.length);
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
        const need = PROVIDERS[chain[0]] || PROVIDERS.opus;
        return sendJson(res, 400, { error: "No API key for " + need.label + ". Set " + need.envHint + " or add it to serve.config.json, then restart the server." });
      }
      let modelChoice;
      try { modelChoice = await resolveModelChoice(payload.model); }
      catch (e) { return sendJson(res, e.status === 400 ? 400 : 503, { error: e.status === 400 ? e.message : "Modellliste nicht verfügbar. Bitte erneut versuchen." }); }
      if (res.destroyed || res.writableEnded) return;
      console.log("POST /q  chain=[" + chain.join(",") + "]  image=" + messagesContainImage(messages) + "  turns=" + messages.length);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      // browser gone (tab closed, :stop, new question) -> abort the upstream generation
      const client = new AbortController();
      res.on("close", () => { if (!res.writableFinished) client.abort(); });
      try {
        await streamWithFallback(payload, res, { signal: client.signal, modelChoice });
      } catch (e) {
        if (e && e.clientGone) { console.log("  client disconnected -> upstream aborted"); return; }
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

    // "no-cache" means revalidate, and without validators every revalidation
    // was a full re-download (pdf.js fetches its 1 MB worker once per lecture).
    // An ETag lets unchanged files come back as a bodyless 304 while edits are
    // still picked up on a normal reload.
    const etag = `W/"${ETAG_SALT}${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const lastModified = st.mtime.toUTCString();
    if (!range && etagMatches(req.headers["if-none-match"], etag)) {
      res.writeHead(304, { "Cache-Control": "no-cache", ETag: etag, "Last-Modified": lastModified });
      return res.end();
    }

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
        ETag: etag,
      });
      if (req.method === "HEAD") return res.end();
      count(fs.createReadStream(filePath, { start, end }).on("error", onErr)).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": st.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        ETag: etag,
        "Last-Modified": lastModified,
      });
      if (req.method === "HEAD") return res.end();
      count(fs.createReadStream(filePath).on("error", onErr)).pipe(res);
    }
  });
}

// The same handler runs in two modes: `node serve.js` starts the local HTTP
// server below; on Vercel, api/index.js imports handleRequest and runs it as
// a serverless function (no listen()).
module.exports = { handleRequest, streamWithFallback, isTransientError };

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch {} });
  server.listen(PORT, () => {
    console.log(`DB Slide Finder  ->  http://localhost:${PORT}`);
    console.log(`serving ${ROOT}`);
    console.log("LLM key present: opus=" + !!KEYS.opus);
    console.log("(Ctrl+C to stop)");
  });
}
