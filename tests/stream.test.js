/* Tutor stream retry / stall / disconnect checks for serve.js streamWithFallback.
 * Run: node tests/stream.test.js
 * Uses a fake streamer (no network, no API key) injected via opts.stream.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// keep the developer's real keys/config out of the module under test
process.env.SLIDEFINDER_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "db-slide-stream-"));
const origLog = console.log;
console.log = () => {};
const {
  streamWithFallback,
  isTransientError,
  fitTutorTurn,
  messageTokens,
  textTokens,
  imageTokens,
  CHAT_SYSTEM,
  CONTEXT_LIMIT,
  HEADROOM,
  TOKEN_BUDGET,
  MAX_TOKENS,
  INPUT_BUDGET,
  SYSTEM_RESERVE,
} = require("../serve.js");

function fakePng(w, h) {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
}
function fakeJpeg(w, h) {
  // SOI, a short APP0, then SOF0. Dimensions sit after the APP segment.
  const app = Buffer.alloc(16);
  app[0] = 0xff; app[1] = 0xe0; app.writeUInt16BE(14, 2);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(11, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof, Buffer.from([0xff, 0xd9])]).toString("base64");
}
function underCeiling(fitted, label) {
  assert.ok(fitted.tokens <= fitted.inputBudget, label + " input " + fitted.tokens + " > " + fitted.inputBudget);
  assert.strictEqual(fitted.maxTokens, MAX_TOKENS);
  assert.ok(fitted.tokens + fitted.maxTokens <= TOKEN_BUDGET, label + " total " + (fitted.tokens + fitted.maxTokens));
  assert.ok(fitted.tokens + fitted.maxTokens <= CONTEXT_LIMIT - HEADROOM, label + " crossed the unused headroom");
  assert.ok(fitted.total <= CONTEXT_LIMIT, label + " crossed 100k");
}

assert.strictEqual(CONTEXT_LIMIT, 100000);
assert.strictEqual(HEADROOM, 20000);
assert.strictEqual(TOKEN_BUDGET, 80000);
assert.strictEqual(MAX_TOKENS, 32000);
assert.strictEqual(INPUT_BUDGET, TOKEN_BUDGET - MAX_TOKENS);
assert.strictEqual(textTokens(""), 0);
assert.strictEqual(textTokens("abcd"), 1);
assert.strictEqual(textTokens("abcde"), 2);
assert.ok(textTokens(CHAT_SYSTEM) <= SYSTEM_RESERVE, "client reserve must cover the system prompt (" + textTokens(CHAT_SYSTEM) + ")");
assert.ok(textTokens(CHAT_SYSTEM) + MAX_TOKENS <= TOKEN_BUDGET);
assert.strictEqual(imageTokens({ type: "image", media_type: "image/png", data: fakePng(2200, 1650) }), Math.ceil(2200 * 1650 / 750));
assert.strictEqual(imageTokens({ type: "image", media_type: "image/jpeg", data: fakeJpeg(30, 40) }), Math.ceil(30 * 40 / 750));
{
  const serveSrc = fs.readFileSync(path.join(__dirname, "..", "serve.js"), "utf8");
  assert.match(serveSrc, /max_tokens: MAX_TOKENS/);
  assert.doesNotMatch(serveSrc, /max_tokens:\s*64000/);
}

{
  const text = "Was ist 3NF?\n\n### a.sql\nSELECT 1;\n\n[Folie 4 | VL | T]\ntext\n\nSchema (SQLite):\nkunde(id)";
  const fitted = fitTutorTurn([{ role: "user", content: text }], "sys");
  assert.strictEqual(fitted.trimmed, false, "a short question is sent as-is");
  assert.strictEqual(fitted.messages[0].content, text, "section parse must round-trip");
  underCeiling(fitted, "short");
}
{
  const slides = [];
  for (let i = 1; i <= 12; i++) slides.push("[Folie " + i + " | VL | t]\n" + "x".repeat(20000));
  const schema = "Schema (SQLite):\nkunde(id)";
  const text = "Was ist 3NF?\n\n" + slides.join("\n\n") + "\n\n" + schema;
  const original = [{ role: "user", content: text }];
  const snapshot = JSON.stringify(original);
  const fitted = fitTutorTurn(original, "You write the course notes.");
  assert.strictEqual(JSON.stringify(original), snapshot, "fitting must not mutate the caller's message");
  assert.strictEqual(fitted.trimmed, true, "oversized slide text is shortened");
  underCeiling(fitted, "slides");
  assert.ok(fitted.messages[0].content.indexOf("Was ist 3NF?") === 0, "the question stays at the front");
  assert.ok(fitted.messages[0].content.indexOf(schema) > 0, "the schema stays whole when it fits");
  assert.ok(fitted.messages[0].content.indexOf("[Folie 1 |") >= 0, "early slide headers stay");
  assert.ok(fitted.messages[0].content.length < text.length, "slide bodies were shortened");
}
{
  // Images are dropped before slide text is touched.
  const slide = "[Folie 1 | VL | t]\nkeep-this-slide-body";
  const blocks = [
    { type: "text", text: "Q?\n\n" + slide },
    { type: "image", media_type: "image/png", data: fakePng(8000, 8000) },
  ];
  const fitted = fitTutorTurn([{ role: "user", content: blocks }], "sys");
  underCeiling(fitted, "image-before-slide");
  assert.ok(!fitted.messages[0].content.some((b) => b.type === "image"), "the image that does not fit is dropped");
  assert.ok(fitted.messages[0].content.some((b) => /keep-this-slide-body/.test(b.text)), "slide text is untouched once the image is gone");
}
{
  const blocks = [
    { type: "text", text: "Lies die Aufgabe im Bild." },
    { type: "text", text: "Screenshot 1" },
    { type: "image", media_type: "image/png", data: fakePng(1000, 1000) },
    { type: "text", text: "Screenshot 2" },
    { type: "image", media_type: "image/png", data: fakePng(8000, 8000) },
  ];
  const fitted = fitTutorTurn([{ role: "user", content: blocks }], "system");
  const imgs = fitted.messages[0].content.filter((b) => b.type === "image");
  const labels = fitted.messages[0].content.filter((b) => b.type === "text" && /Screenshot/.test(b.text));
  underCeiling(fitted, "drop-last-image");
  assert.strictEqual(imgs.length, 1, "the last image is dropped first");
  assert.strictEqual(labels.length, 1);
  assert.strictEqual(labels[0].text, "Screenshot 1");
  assert.strictEqual(fitted.messages[0].content[0].text, "Lies die Aufgabe im Bild.");
}
{
  const only = fitTutorTurn([{
    role: "user",
    content: [{ type: "image", media_type: "image/png", data: fakePng(9000, 9000) }],
  }], "system");
  underCeiling(only, "huge-screenshot");
  assert.ok(!only.messages[0].content.some((b) => b.type === "image"), "a screenshot that cannot fit is not sent");
}
{
  const schema = "Schema (SQLite):\n" + "kunde(id int)\n".repeat(20);
  const text = "Q\n\n### a.sql\n" + "x".repeat(300000) + "\n\n" + schema;
  const fitted = fitTutorTurn([{ role: "user", content: text }], "sys");
  underCeiling(fitted, "file");
  assert.ok(fitted.messages[0].content.startsWith("Q"), "the question stays");
  assert.ok(fitted.messages[0].content.indexOf(schema) > 0, "schema is kept by shortening the file first");
  assert.ok(fitted.messages[0].content.indexOf("x".repeat(300000)) === -1, "the file body was shortened");
}
{
  const q = "Z".repeat((INPUT_BUDGET + 5000) * 4);
  const fitted = fitTutorTurn([{ role: "user", content: q }], "sys");
  underCeiling(fitted, "question");
  assert.ok(fitted.messages[0].content.startsWith("ZZZ"), "a question that itself exceeds the budget is shortened from the end");
  assert.ok(fitted.messages[0].content.length < q.length);
}
{
  // What the browser uploads for a normal screenshot ask still fits, and the
  // server does not have to throw it away.
  const blocks = [
    { type: "text", text: "Was ist die dritte Normalform?\n\nSchema (SQLite):\nkunde(id, name)\nbestellung(id, kunde_id)" },
    { type: "image", media_type: "image/png", data: fakePng(900, 160) },
  ];
  const client = fitTutorTurn([{ role: "user", content: blocks }], "", {
    inputBudget: INPUT_BUDGET - SYSTEM_RESERVE,
  });
  assert.strictEqual(client.trimmed, false, "a normal screenshot ask is uploaded whole");
  const server = fitTutorTurn(client.messages, CHAT_SYSTEM);
  assert.strictEqual(server.trimmed, false, "the server keeps a normal screenshot ask");
  underCeiling(server, "normal-screenshot");
}
{
  const blocks = [{ type: "text", text: "Vergleiche die Diagramme.\n\nSchema (SQLite):\nkunde(id)" }];
  for (let i = 1; i <= 4; i++) {
    blocks.push({ type: "text", text: "Screenshot " + i });
    blocks.push({ type: "image", media_type: "image/png", data: fakePng(2400, 1800) });
  }
  const client = fitTutorTurn([{ role: "user", content: blocks }], "", {
    inputBudget: INPUT_BUDGET - SYSTEM_RESERVE,
  });
  assert.strictEqual(client.messages[0].content.filter((b) => b.type === "image").length, 4,
    "four exam screenshots at paste size still fit");
}
{
  const bogus = fitTutorTurn([{
    role: "user",
    content: [
      { type: "text", text: "Aufgabe" },
      { type: "image", media_type: "image/png", data: "AAAA" },
    ],
  }], "system");
  underCeiling(bogus, "unreadable-image");
  assert.ok(!bogus.messages[0].content.some((b) => b.type === "image"), "an unreadable image is dropped rather than under-billed");
  assert.strictEqual(bogus.messages[0].content[0].text, "Aufgabe");
}

const PAYLOAD = { provider: "opus", messages: [{ role: "user", content: "Was ist 3NF?" }] };
const KEYS = { opus: "test-key" };
const BASE = { keys: KEYS, retryDelayMs: 0 };

function fakeRes() {
  return { out: "", write(t) { this.out += t; } };
}
const err = (status, name) => Object.assign(new Error("boom " + status), { status, name });

(async () => {
  // the server fits before any provider runs, including the retry path
  {
    const huge = "y".repeat(400000);
    const schema = "Schema (SQLite):\nkunde(id)";
    let seen = "";
    await streamWithFallback({
      provider: "opus",
      messages: [{ role: "user", content: "Frage?\n\n[Folie 1 | v | t]\n" + huge + "\n\n" + schema }],
    }, fakeRes(), Object.assign({}, BASE, {
      stream: async (p, key, messages) => { seen = messages[0].content; },
    }));
    assert.ok(seen.startsWith("Frage?"), "the streamed turn keeps the question");
    assert.ok(seen.indexOf(schema) > 0, "the streamed turn keeps the schema");
    assert.ok(seen.length < huge.length, "slide text is shortened before the provider sees it");
    const fitted = { tokens: messageTokens([{ role: "user", content: seen }], CHAT_SYSTEM), maxTokens: MAX_TOKENS, inputBudget: INPUT_BUDGET, total: 0 };
    fitted.total = fitted.tokens + fitted.maxTokens;
    underCeiling(fitted, "stream");
  }

  // transient classification
  assert.ok(isTransientError(err(529)), "529 overloaded is transient");
  assert.ok(isTransientError(err(429)), "429 is transient");
  assert.ok(isTransientError(err(undefined)), "status-less (SSE overloaded / reset) is transient");
  assert.ok(!isTransientError(err(400)), "400 is not transient");
  assert.ok(!isTransientError(err(401)), "401 is not transient");
  assert.ok(!isTransientError(err(undefined, "APIUserAbortError")), "user abort is not transient");
  assert.ok(!isTransientError(Object.assign(err(undefined), { timedOut: true })), "a stall is not transient");

  // 1) transient pre-token failure -> retried once, second attempt streams
  {
    let calls = 0;
    const res = fakeRes();
    const out = await streamWithFallback(PAYLOAD, res, Object.assign({}, BASE, {
      stream: async (p, key, messages, write) => {
        calls++;
        if (calls === 1) throw err(529);
        write("Antwort");
      },
    }));
    assert.strictEqual(calls, 2, "transient failure should be retried once");
    assert.strictEqual(res.out, "Antwort");
    assert.strictEqual(out.provider, "opus");
  }

  // 2) persistent transient failure -> exactly two attempts, then throws
  {
    let calls = 0;
    await assert.rejects(streamWithFallback(PAYLOAD, fakeRes(), Object.assign({}, BASE, {
      stream: async () => { calls++; throw err(503); },
    })), /boom 503/);
    assert.strictEqual(calls, 2, "gives up after one retry");
  }

  // 3) non-transient failure -> no retry
  {
    let calls = 0;
    await assert.rejects(streamWithFallback(PAYLOAD, fakeRes(), Object.assign({}, BASE, {
      stream: async () => { calls++; throw err(400); },
    })), /boom 400/);
    assert.strictEqual(calls, 1, "400 must not be retried");
  }

  // 4) failure after tokens were written -> no retry (can't un-send a partial answer)
  {
    let calls = 0;
    const res = fakeRes();
    await assert.rejects(streamWithFallback(PAYLOAD, res, Object.assign({}, BASE, {
      stream: async (p, key, messages, write) => { calls++; write("halb"); throw err(529); },
    })), /boom 529/);
    assert.strictEqual(calls, 1, "mid-stream failure must not be retried");
    assert.strictEqual(res.out, "halb");
  }

  // 5) silent upstream (no text, no thinking progress) -> aborted as a stall, not retried
  {
    let calls = 0, sawAbort = false;
    await assert.rejects(streamWithFallback(PAYLOAD, fakeRes(), Object.assign({}, BASE, {
      stallMs: 30,
      stream: (p, key, messages, write, signal) => new Promise((resolve, reject) => {
        calls++;
        signal.addEventListener("abort", () => { sawAbort = true; reject(err(undefined, "APIUserAbortError")); });
      }),
    })), /keine Daten seit/);
    assert.ok(sawAbort, "a stall should abort the upstream request");
    assert.strictEqual(calls, 1, "a stall must not be retried");
  }

  // 5b) long thinking with steady progress events outlives the stall window
  {
    const res = fakeRes();
    await streamWithFallback(PAYLOAD, res, Object.assign({}, BASE, {
      stallMs: 40,
      stream: async (p, key, messages, write, signal, effort, onActivity) => {
        for (let t = 0; t < 12; t++) {           // ~120 ms of "thinking", 3x the stall window
          await new Promise((r) => setTimeout(r, 10));
          if (signal.aborted) throw err(undefined, "APIUserAbortError");
          onActivity();
        }
        write("fertig");
      },
    }));
    assert.strictEqual(res.out, "fertig", "thinking progress must keep the attempt alive");
  }

  // 5c) stream that stalls mid-answer is cut off too
  {
    const res = fakeRes();
    await assert.rejects(streamWithFallback(PAYLOAD, res, Object.assign({}, BASE, {
      stallMs: 30,
      stream: (p, key, messages, write, signal) => new Promise((resolve, reject) => {
        write("halb");
        signal.addEventListener("abort", () => reject(err(undefined, "APIUserAbortError")));
      }),
    })), /keine Daten seit/);
    assert.strictEqual(res.out, "halb");
  }

  // 6) client disconnect mid-generation -> upstream aborted, no retry, clientGone
  {
    let calls = 0, sawAbort = false;
    const client = new AbortController();
    const p = streamWithFallback(PAYLOAD, fakeRes(), Object.assign({}, BASE, {
      signal: client.signal,
      stream: (pr, key, messages, write, signal) => new Promise((resolve, reject) => {
        calls++;
        write("teil");
        signal.addEventListener("abort", () => { sawAbort = true; reject(err(undefined, "APIUserAbortError")); });
      }),
    }));
    setTimeout(() => client.abort(), 10);
    await assert.rejects(p, (e) => e.clientGone === true);
    assert.ok(sawAbort, "client disconnect should abort the upstream request");
    assert.strictEqual(calls, 1);
  }

  // 7) client already gone during the retry pause -> no second attempt
  {
    let calls = 0;
    const client = new AbortController();
    await assert.rejects(streamWithFallback(PAYLOAD, fakeRes(), Object.assign({}, BASE, {
      signal: client.signal,
      stream: async () => { calls++; client.abort(); throw err(529); },
    })), (e) => e.clientGone === true);
    assert.strictEqual(calls, 1, "no retry for a client that already left");
  }

  console.log = origLog;
  console.log("stream retry/disconnect checks passed");
})().catch((e) => {
  console.log = origLog;
  console.error(e);
  process.exit(1);
});
