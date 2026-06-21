const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "assets", "app.js"), "utf8");

const select = html.match(/<select id="aiProvider"[\s\S]*?<\/select>/);
assert.ok(select, "provider selector should exist");
const options = select[0].match(/<option\b[^>]*>/g) || [];
assert.strictEqual(options.length, 1, "provider selector should expose exactly one text model");
assert.match(select[0], /<option value="glm">GLM 5\.2<\/option>/);

assert.match(app, /const DEFAULT_PROVIDER = "glm";/);
assert.match(app, /const AI_PROVIDERS = \["glm"\];/);
assert.match(app, /const provider = isImageAsk \? "haiku" : "glm";/);
assert.doesNotMatch(app, /VISION_PROVIDERS|providerCanUseVision/);
assert.doesNotMatch(app, /getSlideImageForVision|slideImgs|VISION_SLIDES/);
assert.doesNotMatch(select[0], /Sonnet|Grok|DeepSeek|Haiku|Codex/);

for (const alias of ["haiku", "claude", "codex", "sonnet", "grok", "deepseek"]) {
  assert.match(app, new RegExp(alias + ': "glm"'), alias + " should remain a compatibility command");
}

console.log("client provider checks passed");
