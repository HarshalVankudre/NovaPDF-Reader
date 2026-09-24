/* End-to-end browser test: Chromium -> real serve.js (spawned) -> real @anthropic-ai/sdk -> model.
 *
 *   npm run test:e2e              mock mode (default, free): the SDK talks to a local mock of the
 *                                 Anthropic API that records every request and streams scripted SSE,
 *                                 so everything except the model's own words runs for real -
 *                                 retrieval, slide rendering for vision, schema injection, streaming,
 *                                 citation checks, SQL auto-run, :stop -> upstream abort, overload
 *                                 retry, the thinking counter.
 *   E2E_LIVE=1 npm run test:e2e   live mode: same flow against the real API with ANTHROPIC_API_KEY
 *                                 (about 5 requests at high effort with slide images - costs money).
 *
 * Needs Playwright + Chromium (not a project dependency): `npm i -g playwright` and
 * `npx playwright install chromium`, or point CHROMIUM_PATH at an existing Chromium.
 * Screenshots land in $E2E_OUT (default: a temp dir, printed at the end).
 */
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
let chromium;
try { ({ chromium } = require("playwright")); }
catch (e) { console.error("playwright not found - install it (npm i -g playwright, then run with NODE_PATH=$(npm root -g))"); process.exit(2); }

const ROOT = path.join(__dirname, "..");
const LIVE = process.env.E2E_LIVE === "1";
if (LIVE && !process.env.ANTHROPIC_API_KEY) { console.error("E2E_LIVE=1 needs ANTHROPIC_API_KEY in the environment"); process.exit(2); }
const HERE = fs.mkdtempSync(path.join(os.tmpdir(), "slidefinder-e2e-"));
const SHOTS = process.env.E2E_OUT ? path.resolve(process.env.E2E_OUT) : path.join(HERE, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const CHROMIUM = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || "" }); };

// ---------------- mock Anthropic API ----------------
const calls = []; // {q, body, headers, closedEarly, kind}
let overloadServed = false;
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, data))}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(body) {
  const m = body.messages[body.messages.length - 1];
  if (typeof m.content === "string") return m.content;
  return m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function providedPages(text) {
  return [...text.matchAll(/\[Folie (\d+) \|/g)].map((m) => +m[1]);
}

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) { res.writeHead(404); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text = textOf(body);
    const call = { body, headers: req.headers, closedEarly: false, text };
    calls.push(call);
    let ended = false;
    res.on("close", () => { if (!ended) call.closedEarly = true; });
    const send = async (s, delay) => { if (res.destroyed) return false; res.write(s); if (delay) await sleep(delay); return !res.destroyed; };
    const finish = () => { ended = true; res.end(); };

    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_mock" });
    await send(ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }));

    const think = async (n, gap) => {
      await send(ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
      for (let i = 0; i < n; i++) if (!(await send(ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Überlege… " } }), gap))) return false;
      await send(ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }));
      await send(ev("content_block_stop", { index: 0 }));
      return true;
    };
    const answer = async (str) => {
      await send(ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }));
      for (const piece of str.match(/[\s\S]{1,12}/g)) await send(ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: piece } }), 15);
      await send(ev("content_block_stop", { index: 1 }));
      await send(ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } }));
      await send(ev("message_stop", {}));
      finish();
    };

    if (/Langsam/.test(text)) {                       // for :stop — thinks, then trickles text forever
      call.kind = "slow";
      await think(2, 200);
      await send(ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }));
      await send(ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Erster Teil der Antwort. " } }));
      while (!res.destroyed) await send(ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "weiter " } }), 300);
      return;
    }
    if (/Überlast/.test(text) && !overloadServed) {  // mid-stream SSE overloaded_error before any text
      call.kind = "overload";
      overloadServed = true;
      await think(2, 100);
      await send(ev("error", { error: { type: "overloaded_error", message: "Overloaded" } }));
      return finish();
    }
    if (body.messages[0].content.some && body.messages[0].content.some((b) => b.type === "image") && !providedPages(text).length) {
      call.kind = "screenshot";
      await think(3, 150);
      return answer("a) **Primärschlüssel:** kunde_id\nb) **Fremdschlüssel:** bestellung.kunde_id");
    }
    call.kind = "text";
    const pages = providedPages(text);
    const cite = pages[0];
    let bogus = 1; while (pages.includes(bogus)) bogus++;
    call.cite = cite; call.bogus = bogus;
    await think(10, 450);                              // ~4.5 s of thinking -> counter must show
    await answer("**3NF:** Relation ist in 2NF und kein Nichtschlüsselattribut hängt transitiv vom Schlüssel ab.\n\n" +
      "Anzahl Kunden:\n```sql\nSELECT COUNT(*) AS anzahl FROM kunde;\n```\n\n(Folie " + cite + ", " + bogus + ")");
  });
});

// small exam-style snapshot: 3 Kunden (Köln x2, Bonn), 3 Bestellungen
async function buildExamDb(file) {
  const SQL = await require("sql.js")();
  const db = new SQL.Database();
  db.run(`CREATE TABLE kunde (kunde_id INTEGER PRIMARY KEY, name TEXT, ort TEXT);
          CREATE TABLE bestellung (bestell_id INTEGER PRIMARY KEY, kunde_id INTEGER REFERENCES kunde(kunde_id), betrag REAL);
          INSERT INTO kunde VALUES (1,'Meyer','Köln'),(2,'Schulz','Bonn'),(3,'Weber','Köln');
          INSERT INTO bestellung VALUES (10,1,19.5),(11,1,5.0),(12,3,42.25);`);
  fs.writeFileSync(file, Buffer.from(db.export()));
}

// ---------------- helpers ----------------
function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error("timeout waiting for " + label);
}
// marks answers already on screen as old, so answerText() only ever reads the new one
const markOld = (page) => page.evaluate(() => document.querySelectorAll(".nt-a").forEach((a) => { a.dataset.old = "1"; }));
async function ask(page, q, chord = "ctrl-alt") {
  await markOld(page);
  await page.fill("#q", q);
  if (chord === "ctrl-alt") {
    await page.keyboard.down("Control"); await page.keyboard.down("Alt");
    await page.press("#q", "Enter");
    await page.keyboard.up("Alt"); await page.keyboard.up("Control");
  } else { // hold d + Enter
    await page.focus("#q");
    await page.keyboard.down("d"); await page.keyboard.press("Enter"); await page.keyboard.up("d");
  }
}
const answerText = (page) => page.$eval(".nt-a:not([data-old])", (a) => a.innerText).catch(() => "");
const idle = (page) => page.waitForFunction(() => !document.getElementById("askAiBtn").disabled, null, { timeout: LIVE ? 300000 : 60000 });
const cmd = async (page, c) => { await page.fill("#q", c); await page.press("#q", "Enter"); };

(async () => {
  const dbFile = path.join(HERE, "exam.sqlite");
  await buildExamDb(dbFile);
  const appPort = 19000 + Math.floor(Math.random() * 500);
  const confDir = fs.mkdtempSync(path.join(HERE, "conf-"));
  const env = Object.assign({}, process.env, { PORT: String(appPort), SLIDEFINDER_CONFIG_DIR: confDir, SLIDEFINDER_SQLITE: dbFile });
  if (!LIVE) Object.assign(env, { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:" + (await listen(mock)) });
  const server = spawn(process.execPath, ["serve.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d)); server.stderr.on("data", (d) => (serverLog += d));
  await waitFor(() => serverLog.includes("http://localhost:" + appPort), 10000, "server start");
  const base = "http://127.0.0.1:" + appPort;

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });

  try {
    // 1. load + viewer + stealth
    await page.goto(base + "/");
    await page.waitForSelector("#pageWrap:not([hidden])", { timeout: 30000 });
    check("app loads, slide 1 renders in the viewer", await page.$eval("#pdfCanvas", (c) => c.width > 0));
    check("stealth: brand header hidden, title 'Notizen' not yet visible",
      await page.$eval("body", (b) => b.classList.contains("stealth")) && !(await page.$(".nt-title")));

    // 2. live search + yellow highlights
    await page.fill("#q", "dritte Normalform");
    await page.waitForSelector(".pg-thumb.result.thumb-ready", { timeout: 30000 });
    await page.waitForTimeout(700);
    const nRes = await page.$$eval(".pg-thumb.result", (a) => a.length);
    const nHl = await page.$$eval(".rc-hl .hl-box", (a) => a.length);
    check("live search returns ranked slides with yellow word highlights", nRes > 0 && nHl > 0, nRes + " results, " + nHl + " highlight boxes");
    await page.click(".pg-thumb.result");
    await page.waitForTimeout(800);
    const mainHl = await page.$$eval("#hlLayer .hl-box", (a) => a.length);
    check("clicking a result opens it with highlights on the main viewer", mainHl > 0, mainHl + " boxes on slide " + (await page.inputValue("#pageInput")));
    await page.screenshot({ path: path.join(SHOTS, "1-search.png") });

    // 3. SQL sandbox auto-loads the snapshot, runs a query
    await cmd(page, ":sql");
    await page.waitForSelector(".sbx-panel:not([hidden])");
    await waitFor(() => page.$eval("#sbxEngine", (e) => /SQLite/i.test(e.textContent)).catch(() => false), 15000, "sqlite engine");
    await waitFor(() => page.$eval("#sbxResults", (e) => /kunde/.test(e.textContent)).catch(() => false), 15000, "snapshot tables");
    await page.fill(".sbx-editor", "SELECT ort, COUNT(*) AS n FROM kunde GROUP BY ort ORDER BY ort;");
    await page.click(".sbx-run");
    await page.waitForSelector("#sbxResults .sbx-table");
    const rows = await page.$$eval("#sbxResults .sbx-table tbody tr", (t) => t.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
    check("sandbox auto-loads exam.sqlite and runs a query", rows.join("|") === "Bonn 1|Köln 2", rows.join(" | "));
    await page.screenshot({ path: path.join(SHOTS, "2-sandbox.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    if (await page.$(".sbx-panel:not([hidden])")) await cmd(page, ":sql");

    // 4. text question -> full RAG request, thinking counter, answer, citation check, SQL auto-run
    const n4 = calls.length;
    await ask(page, "Was ist die dritte Normalform? Und wie viele Kunden gibt es in der Datenbank?");
    await page.waitForSelector(".nt-a", { timeout: 15000 });
    const counter = await waitFor(() => page.$eval(".nt-wait", (e) => e.textContent).catch(() => null), LIVE ? 20000 : 8000, "thinking counter").catch(() => null);
    check("elapsed-seconds counter shows while the model thinks", LIVE ? true : /^\d+ s$/.test(counter), counter ? "showed '" + counter + "'" : "answer came before 3 s");
    await page.screenshot({ path: path.join(SHOTS, "3-thinking.png") });
    await idle(page);
    const ans = await answerText(page);
    const refs = await page.$$eval(".nt-a .nt-ref", (a) => a.map((x) => +x.dataset.page));
    if (!LIVE) {
      const call = calls[n4];
      const b = call.body;
      const imgs = b.messages[0].content.filter((x) => x.type === "image");
      check("request: model/effort/thinking/max_tokens as configured",
        b.model === "claude-fable-5" && b.output_config.effort === "high" && b.thinking.type === "adaptive" &&
        b.thinking.display === "summarized" && b.max_tokens === 64000 && !("temperature" in b),
        `${b.model} effort=${b.output_config.effort} thinking=${JSON.stringify(b.thinking)} max_tokens=${b.max_tokens}`);
      check("request: refusal fallback to Opus 4.8 via beta header",
        JSON.stringify(b.fallbacks) === '[{"model":"claude-opus-4-8"}]' && /server-side-fallback-2026-06-01/.test(call.headers["anthropic-beta"] || ""));
      check("request: system prompt is the notes prompt (stealth rule present)", /course notes \("Notizen"\)/.test(b.system) && /never mention being an AI/.test(b.system));
      check("request: top BM25 slides sent as text", providedPages(call.text).length === 12, providedPages(call.text).length + " slides");
      check("request: top slides attached as rendered images (vision)", imgs.length >= 3 && imgs.every((x) => x.source.media_type === "image/jpeg" && x.source.data.length > 50000),
        imgs.length + " images, " + imgs.map((x) => Math.round(x.source.data.length / 1024) + "KB").join("/"));
      check("request: imported DB schema + dialect included", /Importiertes Datenbank-Schema \(Dialekt: SQLite/.test(call.text) && /kunde/.test(call.text) && /bestellung/.test(call.text));
      check("answer streams into the Notizen pane (markdown rendered)", /3NF:/.test(ans) && (await page.$(".nt-a strong")) !== null);
      check("citation check keeps the provided slide and strips the unprovided one",
        refs.includes(call.cite) && !refs.includes(call.bogus), "links: " + refs.join(",") + " (cited " + call.cite + " + bogus " + call.bogus + ")");
    } else {
      check("live answer arrives without an error", ans.length > 40 && !/Fehler|abgelehnt/.test(ans), JSON.stringify(ans.slice(0, 160)));
      check("live answer cites real slides (or marks itself allg.)", refs.every((p) => p >= 1 && p <= 317) && (refs.length > 0 || /allg\./.test(ans)), "links: " + (refs.join(",") || "none"));
    }
    const sqlRes = await waitFor(() => page.$eval(".nt-sql-result", (e) => e.innerText).catch(() => null), LIVE ? 20000 : 10000, "inline sql result").catch(() => "");
    check("read-only SQL in the answer auto-runs against the snapshot (3 Kunden)", /\b3\b/.test(sqlRes) && !/Fehler|error/i.test(sqlRes), sqlRes.replace(/\s+/g, " "));
    await page.screenshot({ path: path.join(SHOTS, "4-answer.png") });
    if (refs.length) {
      await page.click(".nt-a .nt-ref");
      await page.waitForTimeout(600);
      check("clicking a (Folie N) citation jumps the viewer to that slide", +(await page.inputValue("#pageInput")) === refs[0]);
    }

    // 5. mid-stream overload -> server retries once, answer still arrives (mock only)
    if (!LIVE) {
      const before = calls.length;
      await ask(page, "Überlast: Was ist ein Fremdschlüssel?");
      await idle(page);
      const retryCalls = calls.slice(before);
      const ans5 = await answerText(page);
      check("overloaded_error before any text is retried once and answered",
        retryCalls.length === 2 && retryCalls[0].kind === "overload" && /3NF/.test(ans5) && !/Fehler/.test(ans5),
        retryCalls.map((c) => c.kind).join(" -> "));
    }

    // 6. :stop mid-answer -> partial kept, upstream generation aborted
    const n6 = calls.length;
    await ask(page, LIVE ? "Erkläre ausführlich mit je einem Beispiel alle vier ACID-Eigenschaften und alle SQL-Isolationsstufen samt Anomalien."
                         : "Langsam: erkläre ACID ausführlich");
    // live: stop as soon as the first words stream in (a long answer at high effort is still running then)
    if (LIVE) await waitFor(async () => (await answerText(page)).replace(/\d+ s$/, "").trim().length > 20, 240000, "first live text");
    else { await waitFor(async () => /Erster Teil/.test(await answerText(page)), 15000, "slow first text"); await page.waitForTimeout(700); }
    const stillRunning = await page.$eval("#askAiBtn", (b) => b.disabled);
    await cmd(page, ":stop");
    await idle(page);
    await page.waitForTimeout(800);
    const ans6 = await answerText(page);
    if (stillRunning) {
      check(":stop ends the answer, keeps any partial text, marked abgebrochen", /abgebrochen/.test(ans6) && (LIVE || /Erster Teil/.test(ans6)), JSON.stringify(ans6.slice(-60)));
      if (!LIVE) check(":stop closes the upstream Anthropic request (no runaway generation)", calls[n6] && calls[n6].closedEarly);
      check("server log confirms the upstream request was aborted", /client disconnected -> upstream aborted/.test(serverLog));
    } else {
      check(":stop (skipped - the answer finished before it could be stopped)", true);
    }

    // 7. :fast -> medium effort, no slide images; hold-d+Enter chord
    await cmd(page, ":fast");
    const n7 = calls.length;
    await ask(page, "Was ist ACID?", "d-enter");
    await idle(page);
    if (!LIVE) {
      const c7 = calls[n7];
      check("hold d + Enter asks (and the typed d's are stripped)", c7 && !/^d|dd/.test(c7.text.split("\n")[0]), c7 && JSON.stringify(c7.text.split("\n")[0]));
      check(":fast sends text only at medium effort", c7 && c7.body.output_config.effort === "medium" && !c7.body.messages[0].content.some((x) => x.type === "image"));
    } else {
      const a7 = await answerText(page);
      check("hold d + Enter asks; :fast answer arrives", /atom|konsist|isol|dauerh/i.test(a7) && !/Fehler/.test(a7), JSON.stringify(a7.slice(0, 120)));
    }
    await cmd(page, ":vision");

    // 8. pasted screenshot -> self-contained image question, no slide context
    await page.evaluate(async () => {
      const c = document.createElement("canvas"); c.width = 900; c.height = 160;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 900, 160); g.fillStyle = "#000"; g.font = "22px sans-serif";
      g.fillText("Aufgabe (Datenbank oben): a) Primärschlüssel der Tabelle kunde?", 10, 60);
      g.fillText("b) Welches Attribut ist Fremdschlüssel in bestellung?", 10, 110);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer(); dt.items.add(new File([blob], "aufgabe.png", { type: "image/png" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    });
    await page.waitForSelector(".att-thumb", { timeout: 5000 });
    await page.waitForTimeout(300);
    check("pasted screenshot attaches as a chip (never auto-asks)", LIVE ? !(await page.$eval("#askAiBtn", (b) => b.disabled)) : calls.length === n7 + 1);
    const n8 = calls.length;
    await markOld(page);
    await page.fill("#q", "");
    await page.focus("#q");
    await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.press("#q", "Enter");
    await page.keyboard.up("Alt"); await page.keyboard.up("Control");
    await idle(page);
    const a8 = await answerText(page);
    if (!LIVE) {
      const c8 = calls[n8];
      const c8imgs = c8 ? c8.body.messages[0].content.filter((x) => x.type === "image") : [];
      check("screenshot ask sends the image, schema, and no slide excerpts",
        c8 && c8.kind === "screenshot" && c8imgs.length === 1 && c8imgs[0].source.media_type === "image/png" && /kunde/.test(c8.text),
        c8 ? c8.kind + ", " + c8imgs.length + " image" : "no call");
    }
    check("screenshot answer uses the real schema (kunde_id)", /kunde_id/.test(a8), JSON.stringify(a8.slice(0, 160)));
    await page.screenshot({ path: path.join(SHOTS, "5-screenshot-answer.png") });

    // 9. Esc closes the notes, back to the search UI
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Esc hides the notes and restores the results list", await page.$eval("#aiPanel", (e) => e.hidden) && !(await page.$eval("#results", (e) => e.hidden)));

    // 10. :new while streaming aborts too (mock only - :stop already proved it live)
    if (!LIVE) {
      const n10 = calls.length;
      await ask(page, "Langsam: noch einmal");
      await waitFor(async () => /Erster Teil/.test(await answerText(page)), 15000, "slow text 2");
      await cmd(page, ":new");
      await page.waitForTimeout(800);
      check(":new aborts the running answer upstream", calls[n10] && calls[n10].closedEarly);
    }

    check("no page errors in the browser console", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    check("harness completed", false, e.stack.split("\n").slice(0, 3).join(" "));
    await page.screenshot({ path: path.join(SHOTS, "error.png") }).catch(() => {});
  } finally {
    await browser.close();
    server.kill();
    if (!LIVE) mock.close();
    fs.rmSync(confDir, { recursive: true, force: true });
    const w = Math.max(...results.map((r) => r.name.length));
    for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name.padEnd(w) + (r.detail ? "  · " + r.detail : ""));
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(HERE, "server.log"), serverLog);
    console.log("\n" + (results.length - failed) + "/" + results.length + " passed (" + (LIVE ? "live API" : "mock API, " + calls.length + " upstream requests") + ")");
    console.log("screenshots: " + SHOTS + " · server log: " + path.join(HERE, "server.log"));
    process.exit(failed ? 1 : 0);
  }
})();
