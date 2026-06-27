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

const slideRefLiteral = app.match(/const SLIDE_REF_RE = (\/[^\n]+\/g);/);
assert.ok(slideRefLiteral, "chat renderer should centralize slide-reference parsing");
const slideRefRe = Function('"use strict"; return ' + slideRefLiteral[1])();
function linkSlideRefsLikeRenderer(text) {
  return text.replace(slideRefRe, function (m, kw, nums) {
    return kw + " " + nums.replace(/\d+/g, function (n) {
      return '<a class="nt-ref" data-page="' + n + '">' + n + "</a>";
    });
  });
}
const longRef = linkSlideRefsLikeRenderer("Siehe Folie 99999");
assert.match(longRef, /data-page="99999">99999<\/a>/, "long numeric refs should be linked as a whole number");
assert.doesNotMatch(longRef, /data-page="999">999<\/a>99/, "long numeric refs must not be partially linked");
assert.match(
  linkSlideRefsLikeRenderer("Siehe Folie 1, Folie 99999"),
  /data-page="1">1<\/a>, Folie <a class="nt-ref" data-page="99999">99999<\/a>/,
  "repeated Folie labels in one reference list should be parsed"
);
assert.match(
  app,
  /let citationSlides = \[\];/,
  "streaming answers should track the exact slides that were sent as context"
);
assert.match(
  app,
  /const pickedSlides = res\.results\.slice\(0,\s*12\);/,
  "text questions should keep a concrete candidate slide list for citation checks"
);
assert.match(
  app,
  /citationSlides = pickedSlides\.map\(\(r\) => data\.slides\[r\.docId\]\)\.filter\(Boolean\);/,
  "citation checks should use only the candidate slides sent to the model"
);
assert.match(
  app,
  /SlideSearchEngine\.verifyCitations\(assistantTurn\.content,\s*citationSlides\)/,
  "streaming answers should verify final slide citations against candidate slides before rendering"
);

console.log("client provider checks passed");
