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
const { streamWithFallback, isTransientError } = require("../serve.js");

const PAYLOAD = { provider: "opus", messages: [{ role: "user", content: "Was ist 3NF?" }] };
const KEYS = { opus: "test-key" };
const BASE = { keys: KEYS, retryDelayMs: 0 };

function fakeRes() {
  return { out: "", write(t) { this.out += t; } };
}
const err = (status, name) => Object.assign(new Error("boom " + status), { status, name });

(async () => {
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
