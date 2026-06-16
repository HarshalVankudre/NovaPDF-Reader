/* Server regression harness for DB Slide Finder.
 * Run: node tests/server.test.js
 * Starts serve.js on a throwaway port and verifies static-file guardrails,
 * byte ranges, method restrictions, and the disguised /lec endpoint.
 */
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = "http://127.0.0.1:" + PORT;

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("server did not start\n" + output)), 8000);
    const onData = (buf) => {
      output += buf.toString("utf8");
      if (output.includes("http://localhost:" + PORT)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error("server exited early with code " + code + "\n" + output)));
  });
}

async function request(pathname, init) {
  return fetch(BASE + pathname, init);
}

(async () => {
  const child = spawn(process.execPath, ["serve.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
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

    console.log("server regression checks passed");
  } finally {
    child.kill();
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
