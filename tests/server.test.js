/* Server regression harness for DB Slide Finder.
 * Run: node tests/server.test.js
 * Starts serve.js on a throwaway port and verifies static-file guardrails,
 * byte ranges, method restrictions, and the disguised /lec endpoint.
 */
const assert = require("assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = "http://127.0.0.1:" + PORT;

function waitForReady(child, port) {
  port = port || PORT;
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("server did not start\n" + output)), 8000);
    const onData = (buf) => {
      output += buf.toString("utf8");
      if (output.includes("http://localhost:" + port)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error("server exited early with code " + code + "\n" + output)));
  });
}

// End-to-end check of the default Qwen 3.5 Flash path WITHOUT touching the real
// OpenRouter API: stand up a mock OpenAI-compatible endpoint, point serve.js at
// it via OPENROUTER_API_URL, POST a chat through /q, and assert (a) the streamed
// tokens reach the client and (b) the upstream request carries the fast Qwen
// slug with reasoning disabled.
async function testFastTutorModel() {
  const mockPort = 20000 + Math.floor(Math.random() * 2000);
  const srvPort = 20000 + Math.floor(Math.random() * 2000) + 2500;
  let captured = null;
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { captured = JSON.parse(body); } catch (e) { captured = {}; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" Welt"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => mock.listen(mockPort, "127.0.0.1", r));
  const child = spawn(process.execPath, ["serve.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(srvPort),
      OPENROUTER_API_KEY: "test-key", // grok routes through OpenRouter now
      OPENROUTER_API_URL: "http://127.0.0.1:" + mockPort + "/v1/chat/completions",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child, srvPort);
    const resp = await fetch("http://127.0.0.1:" + srvPort + "/q", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "grok", messages: [{ role: "user", content: [{ type: "text", text: "Sag Hallo" }] }] }),
    });
    assert.strictEqual(resp.status, 200, "grok /q should stream (200)");
    const text = await resp.text();
    assert.match(text, /Hallo Welt/, "client should receive the streamed grok tokens");
    assert.ok(captured, "mock xAI should have received the upstream request");
    assert.strictEqual(captured.model, "qwen/qwen3.5-flash-02-23", "chat must use the fast Qwen 3.5 Flash slug");
    assert.ok(captured.reasoning && captured.reasoning.effort === "none", "chat must disable reasoning");
    assert.strictEqual(captured.stream, true, "chat must stream");
    assert.doesNotMatch(captured.messages[0].content, /provided slide|Folie N|slides do not contain/i,
      "system prompt must not require slide context or citations");
    assert.match(captured.messages[0].content, /greetings.*naturally.*briefly/i,
      "system prompt must allow a brief natural response to greetings");
    assert.doesNotMatch(captured.messages[0].content, /No greetings/i,
      "system prompt must not suppress greeting responses");
    assert.deepStrictEqual(captured.messages[1], {
      role: "user",
      content: [{ type: "text", text: "Sag Hallo" }],
    }, "the user message should pass upstream without injected slide context");
    console.log("fast tutor model end-to-end check passed");
  } finally {
    child.kill();
    mock.close();
  }
}

async function request(pathname, init) {
  return fetch(BASE + pathname, init);
}

// Raw request: Node's http client never auto-decompresses or auto-adds
// Accept-Encoding, so the Content-Encoding header and the raw bytes survive
// for inspection (global fetch transparently gunzips and hides both).
function rawGet(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + pathname, { method: "GET", headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const child = spawn(process.execPath, ["serve.js"], {
    cwd: ROOT,
    // Scrub the OpenRouter key so the missing-key check is deterministic and
    // offline (no real network call / token spend) regardless of the dev's env.
    // The grok streaming test below uses its own mock endpoint.
    env: Object.assign({}, process.env, { PORT: String(PORT), OPENROUTER_API_KEY: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForReady(child);

    const index = await request("/");
    assert.strictEqual(index.status, 200, "index should load");
    assert.match(index.headers.get("content-type") || "", /^text\/html/i);

    const config = await request("/serve.config.json");
    assert.strictEqual(config.status, 403, "serve.config.json must not be exposed");

    const dotfile = await request("/.git/config");
    assert.strictEqual(dotfile.status, 403, ".git files must not be exposed");

    const traversal = await request("/%2e%2e/serve.config.json");
    assert.strictEqual(traversal.status, 403, "encoded traversal must stay blocked");

    const directPdf = await request("/assets/lectures/vl1.pdf");
    assert.strictEqual(directPdf.status, 404, "lecture PDFs must not have direct static URLs");

    const lec = await request("/lec/1", { method: "HEAD" });
    assert.strictEqual(lec.status, 200, "/lec/1 should be available");
    assert.match(lec.headers.get("content-type") || "", /^text\/plain/i);
    assert.ok(Number(lec.headers.get("content-length")) > 0, "/lec/1 should report a body size");

    const range = await request("/index.html", { headers: { Range: "bytes=0-9" } });
    assert.strictEqual(range.status, 206, "normal byte range should work");
    assert.match(range.headers.get("content-range") || "", /^bytes 0-9\//);
    assert.strictEqual(await range.text(), "<!DOCTYPE ");

    const suffix = await request("/index.html", { headers: { Range: "bytes=-6" } });
    assert.strictEqual(suffix.status, 206, "suffix byte range should work");
    assert.strictEqual(Number(suffix.headers.get("content-length")), 6);

    const badRange = await request("/index.html", { headers: { Range: "bytes=999999999-" } });
    assert.strictEqual(badRange.status, 416, "unsatisfiable range should return 416");

    const getQ = await request("/q");
    assert.strictEqual(getQ.status, 405, "/q only accepts POST");

    // ---- caching + compression ----------------------------------------------
    const gz = await rawGet("/assets/app.js", { "Accept-Encoding": "gzip" });
    assert.strictEqual(gz.status, 200, "app.js should load");
    assert.strictEqual((gz.headers["content-encoding"] || "").toLowerCase(), "gzip", "text assets should be gzipped");
    assert.ok(gz.body[0] === 0x1f && gz.body[1] === 0x8b, "gzip body should carry the gzip magic bytes");
    assert.match(gz.headers["etag"] || "", /-gz"$/, "gzip responses use an encoding-specific ETag");
    assert.match(gz.headers["vary"] || "", /accept-encoding/i, "compressed responses must Vary on Accept-Encoding");

    const first = await rawGet("/assets/search-engine.js", { "Accept-Encoding": "gzip" });
    const etag = first.headers["etag"];
    assert.ok(etag, "static files should carry an ETag");
    const second = await rawGet("/assets/search-engine.js", { "Accept-Encoding": "gzip", "If-None-Match": etag });
    assert.strictEqual(second.status, 304, "matching If-None-Match should yield 304");
    assert.strictEqual(second.body.length, 0, "304 must have an empty body");

    const lib = await rawGet("/assets/pdf.min.js", { "Accept-Encoding": "gzip" });
    assert.match(lib.headers["cache-control"] || "", /max-age=2592000/, "pdf.min.js should cache hard");
    const src = await rawGet("/assets/app.js", {});
    assert.match(src.headers["cache-control"] || "", /no-cache/, "source files should revalidate");

    const ranged = await rawGet("/index.html", { "Accept-Encoding": "gzip", Range: "bytes=0-9" });
    assert.strictEqual(ranged.status, 206, "ranged request should still work");
    assert.ok(!ranged.headers["content-encoding"], "ranged responses must not be gzipped");

    const lec1 = await rawGet("/lec/1", { "Accept-Encoding": "gzip" });
    assert.strictEqual(lec1.status, 200, "/lec/1 should serve");
    assert.ok(!lec1.headers["content-encoding"], "/lec PDFs must not be gzipped");
    assert.match(lec1.headers["cache-control"] || "", /max-age=2592000/, "/lec should cache hard");
    const lecEtag = lec1.headers["etag"];
    assert.ok(lecEtag, "/lec should carry an ETag");
    const lec304 = await rawGet("/lec/1", { "If-None-Match": lecEtag });
    assert.strictEqual(lec304.status, 304, "/lec should 304 on a matching ETag");

    // ---- AI wiring: the only provider is Qwen; a missing key → clear 400 ------
    const noKey = await request("/q", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) });
    assert.strictEqual(noKey.status, 400, "with no key, /q should 400 instantly (never reach the network)");
    const noKeyErr = (await noKey.json()).error || "";
    assert.match(noKeyErr, /no api key/i, "the 400 should be the missing-key message");
    assert.match(noKeyErr, /qwen/i, "the only provider is Qwen 3.5 Flash");
    assert.match(noKeyErr, /OPENROUTER_API_KEY/, "the key hint should be OPENROUTER_API_KEY");

    console.log("server regression checks passed");
  } finally {
    child.kill();
  }

  await testFastTutorModel();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
