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
assert.match(app, /const VISION_MAX = 4;/, "diagram-heavy near-top slides may add a 4th vision image");
assert.match(app, /renderSlideForVision\(/);
assert.match(app, /let fastMode = false;/);
// each slide image is labeled with its page so the model's citations stay precise
assert.match(app, /"Bild von Folie " \+ im\.page/, "vision images should be labeled with their Folie number");
// generated ```sql blocks are syntax-colored via a tokenize→escape→wrap pass
assert.match(app, /function highlightSql\(/, "SQL code blocks in answers should be syntax-colored");
// short conversational memory: prior Q/A pairs precede the fresh turn
assert.match(app, /const messages = history\.concat\(\[\{ role: "user", content: blocks \}\]\);/,
  "follow-up questions should carry the recent thread as history");

// paste = ask: exam-question-looking pastes (text or screenshot) ask instantly
assert.match(app, /function looksLikeExamQuestion\(/, "pasted exam tasks should be detected");
assert.match(app, /document\.addEventListener\("paste"/, "paste should work anywhere in the app");
// auto-run is gated to provably read-only SQL (WITH … DELETE must never auto-run)
assert.match(app, /const READONLY_SQL = /, "auto-run must whitelist read-only statement starts");
assert.match(app, /const WRITE_SQL = /, "auto-run must additionally blacklist write keywords");
// self-repair loop: sandbox dispatches, app listens
assert.match(app, /addEventListener\("sqlfix"/, "the app should listen for the sandbox fix event");
const sandbox = fs.readFileSync(path.join(ROOT, "assets", "sandbox.js"), "utf8");
assert.match(sandbox, /CustomEvent\("sqlfix"/, "a failed sandbox query should offer one-click repair");
// viewer magic: region snip, citation hover previews, cursor-anchored zoom
assert.match(app, /async function snipRegion\(/, "Alt+drag region snip should exist");
assert.match(html, /id="snipBtn"/, "the ✂ toolbar button should exist");
assert.match(app, /function showRefPreview\(/, "citation hover previews should exist");
assert.match(app, /function zoomAt\(/, "cursor-anchored zoom should exist");
// notes survive a reload (text-only persistence)
assert.match(app, /function persistThread\(/, "the thread should persist across reloads");

// Gegenprüfung: an independent shadow solve runs IN PARALLEL with the visible
// answer; identical results confirm for free, a quick compare handles phrasing
// differences, and real conflicts go to a strict arbiter (2-of-3) so a wrong
// "correction" can't flip a right answer
assert.match(app, /const shadowPromise = wantCheck \? postQ\(messages\)/,
  "the shadow solve should start in parallel with the visible answer");
assert.match(app, /async function crossCheckAnswer\(/, "answers should be cross-checked");
assert.match(app, /function normalizeVerdictText\(/, "identical results should confirm without an extra call");
assert.match(app, /"GLEICH"/, "the compare verdict protocol should exist");
assert.match(app, /Schiedsprüfung/, "conflicts should be settled by an arbiter solve");
assert.match(app, /async function sqlEvidenceFor\(/, "SQL answers should be checked against real execution evidence");
assert.match(sandbox, /async function execForCheck\(/, "the sandbox should expose the silent evidence executor");
// one-press stealth + lean vision for pasted tasks
assert.match(app, /function panicHide\(/, "a single Esc should drop to the bare viewer");
assert.match(app, /const pastedTask = q\.length >= 160;/, "pasted tasks should skip weak slide-image overhead");
// resilience + rapid-fire flow
assert.match(app, /async function postQ\(/, "tutor requests should retry once before failing");
assert.match(app, /askQueue\.shift\(\)/, "questions pasted while streaming should queue and fire automatically");
// per-request effort routing: arbiter deepest, :fast snappier, server whitelists
assert.match(app, /postQ\(history\.concat\(\[\{ role: "user", content: adjBlocks \}\]\), "xhigh"\)/,
  "the arbiter should run at maximum reasoning depth");
const serve = fs.readFileSync(path.join(ROOT, "serve.js"), "utf8");
assert.match(serve, /function normalizeEffort\(/, "the server should whitelist client effort overrides");
assert.match(serve, /normalizeEffort\(payload && payload\.effort\)/, "the /q payload effort should be honored");

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
  /SlideSearchEngine\.verifyCitations\(assistantTurn\.content,\s*citationSlides,\s*\{\s*\n?\s*trustedPages:/,
  "streaming answers should verify final slide citations against candidate slides, trusting image-attached pages"
);

console.log("client provider checks passed");
