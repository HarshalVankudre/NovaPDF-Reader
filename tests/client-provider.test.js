const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "assets", "app.js"), "utf8");

// Single hardcoded model: no provider dropdown, no aliases, no switching commands.
assert.doesNotMatch(html, /id="aiProvider"/, "the provider selector should be gone");
assert.match(app, /const AI_PROVIDER = "opus";/, "Opus is the only model");
assert.doesNotMatch(app, /PROVIDER_ALIASES/, "provider aliases should be removed");
assert.doesNotMatch(app, /aiProviderSel/, "the provider selector wiring should be removed");
// every ask sends the one model
assert.match(app, /const provider = AI_PROVIDER;/);
// vision grounding: typed questions attach rendered top-slide images unless :fast is on
assert.match(app, /const VISION_SLIDES = 3;/);
assert.match(app, /renderSlideForVision\(/);
assert.match(app, /let fastMode = false;/);

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
