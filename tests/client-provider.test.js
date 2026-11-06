const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "assets", "app.js"), "utf8");

// The provider remains Anthropic; model selection lives in the hidden settings.
assert.doesNotMatch(html, /id="aiProvider"/, "the provider selector should be gone");
assert.match(app, /const AI_PROVIDER = "opus";/, "the Anthropic transport id stays stable");
assert.doesNotMatch(app, /PROVIDER_ALIASES/, "provider aliases should be removed");
assert.doesNotMatch(app, /aiProviderSel/, "the provider selector wiring should be removed");
// vision grounding: typed questions attach rendered top-slide images unless :fast is on
assert.match(app, /const VISION_SLIDES = 3;/);
assert.match(app, /const VISION_MAX = 4;/, "diagram-heavy near-top slides may add a 4th vision image");
assert.match(app, /renderSlideForVision\(/);
assert.match(app, /let fastMode = false;/);
// each slide image is labeled with its page so the model's citations stay precise
assert.match(app, /"Bild von Folie " \+ im\.page/, "vision images should be labeled with their Folie number");
// generated ```sql blocks are syntax-colored via a tokenize→escape→wrap pass
assert.match(app, /function highlightSql\(/, "SQL code blocks in answers should be syntax-colored");
// ONE-SHOT: every ask sends exactly one user turn — no conversational memory,
// and asking wipes the previous exchange from panel + memory
assert.match(app, /const messages = \[\{ role: "user", content: blocks \}\];/,
  "each question must be sent without any thread history");
assert.doesNotMatch(app, /history\.concat/, "no request may carry prior Q/A pairs");

// paste can NEVER reach the tutor — the paste-to-ask feature is fully removed
// (a lingering localStorage flag from old builds must not resurrect it either)
assert.doesNotMatch(app, /autoAsk/, "paste-to-ask must not exist at all");
assert.doesNotMatch(app, /looksLikeExamQuestion/, "the exam-task paste heuristic must be gone");
assert.match(app, /localStorage\.removeItem\("aiAutoAsk"\)/, "the old paste-to-ask flag must be purged at startup");
assert.match(app, /localStorage\.getItem\("aiCheck"\) === "1"/, "Gegenprüfung must stay off unless :check stored an explicit on");
assert.match(app, /document\.addEventListener\("paste"/, "paste should still attach/search anywhere in the app");
// viewer magic: region snip, citation hover previews, cursor-anchored zoom
assert.match(app, /async function snipRegion\(/, "Alt+drag region snip should exist");
// region snipping is Alt+drag only; the SQL toolbar feature has been removed
assert.doesNotMatch(html, /id="snipBtn"/, "the ✂ toolbar button must be gone");
assert.doesNotMatch(html, /id="sqlBtn"/, "the SQL toolbar button must be gone");
assert.match(app, /function showRefPreview\(/, "citation hover previews should exist");
assert.match(app, /function zoomAt\(/, "cursor-anchored zoom should exist");
// ONE-SHOT: nothing persists — persistThread actively removes any stored thread
assert.match(app, /localStorage\.removeItem\(THREAD_KEY\)/, "any stored thread must be actively deleted");
assert.doesNotMatch(app, /localStorage\.setItem\(THREAD_KEY/, "the thread must never be written to localStorage");

// Gegenprüfung is OFF by default (:check opts in); when on: an independent
// shadow solve runs IN PARALLEL with the visible answer; identical results
// confirm for free, a quick compare handles phrasing differences, and real
// conflicts go to a strict arbiter (2-of-3) so a wrong "correction" can't
// flip a right answer
assert.match(app, /let checkMode = false;/, "the automatic Gegenprüfung must be OFF by default");
assert.match(app, /const shadowPromise = wantCheck \? postQ\(messages[,)]/,
  "the shadow solve should start in parallel with the visible answer");
assert.match(app, /async function crossCheckAnswer\(/, "answers should be cross-checked");
assert.match(app, /function normalizeVerdictText\(/, "identical results should confirm without an extra call");
assert.match(app, /"GLEICH"/, "the compare verdict protocol should exist");
assert.match(app, /Schiedsprüfung/, "conflicts should be settled by an arbiter solve");
// Esc closes only the notes and restores the normal UI — never hides the sidebar
assert.match(app, /function panicHide\(/, "Esc should close the notes and restore the normal UI");
assert.doesNotMatch(app, /classList\.add\("viewer-only"\)/, "Esc must not hide the search sidebar");
assert.match(app, /const pastedTask = q\.length >= 160;/, "pasted tasks should skip weak slide-image overhead");
// resilience + rapid-fire flow
assert.match(app, /async function postQ\(/, "tutor requests should retry once before failing");
assert.match(app, /askQueue\.shift\(\)/, "questions pasted while streaming should queue and fire automatically");
assert.match(app, /function stopAsk\(/, ":stop should abort the streaming answer");
assert.match(app, /signal: signal,/, "tutor requests should be abortable");
assert.match(app, /assistantTurn\.content = acc \? acc \+ /, "a failed/aborted stream must keep the partial answer");
// per-request effort routing: arbiter deepest, :fast snappier, server whitelists
assert.match(app, /postQ\(\[\{ role: "user", content: adjBlocks \}\], "xhigh", undefined, settings\)/,
  "the arbiter should run at maximum reasoning depth");
const serve = fs.readFileSync(path.join(ROOT, "serve.js"), "utf8");
assert.match(serve, /function normalizeEffort\(/, "the server should whitelist client effort overrides");
assert.match(serve, /normalizeEffort\(payload && payload\.effort\)/, "the /q payload effort should be honored");
// Fable 5 refusal safety net: a classifier decline is re-served by Opus 4.8
// on the same stream (server-side fallback beta), gated to Fable/Mythos models
assert.match(serve, /FABLE_FALLBACK_BETA = "server-side-fallback-2026-06-01"/, "the refusal-fallback beta must be pinned");
assert.match(serve, /fallbacks: \[\{ model: FABLE_FALLBACK_MODEL \}\]/, "Fable requests should carry the Opus fallback");
assert.match(serve, /isFableModel\(p\.model\)/, "the fallback beta must only apply to Fable/Mythos models");

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

// Exercise the real viewer functions without starting the app or calling an API.
function viewerHarness(fetchImpl, renderImpl) {
  const elements = new Map();
  const metrics = { renders: 0, failNextRender: false };
  const element = () => ({
    hidden: false, style: {}, clientWidth: 800,
    getContext: () => ({}),
    toDataURL() { return "data:image/jpeg;base64," + this.width + ":" + metrics.renders; },
  });
  const page = {
    getViewport: ({ scale }) => ({ width: 800 * scale, height: 600 * scale }),
    render() {
      metrics.renders++;
      if (renderImpl) return renderImpl(metrics.renders);
      const fail = metrics.failNextRender;
      metrics.failNextRender = false;
      return { promise: fail ? Promise.reject(new Error("raster failed")) : Promise.resolve(), cancel() {} };
    },
  };
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element,
    },
    window: { devicePixelRatio: 1 },
    pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({ getPage: async () => page }) }) },
    fetch: fetchImpl || (async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })),
  });
  const bootstrap = '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);\n  else init();';
  const source = app.replace(/\r\n/g, "\n");
  assert.ok(source.includes(bootstrap), "viewer test must replace only the startup call");
  vm.runInContext(source.replace(bootstrap,
    '  pageToLecture = Array.from({ length: 24 }, (_, p) => ({ num: p, startPage: p, name: "VL" + p }));\n' +
    '  globalThis.viewer = { renderSlideForVision, renderMain };'), context);
  return { viewer: context.viewer, elements, metrics };
}

async function viewerChecks() {
  const checks = [
    ["reuses slide images while respecting render size and a bounded cache", async () => {
      const { viewer, metrics } = viewerHarness();
      const images = await Promise.all([viewer.renderSlideForVision(1, 2200), viewer.renderSlideForVision(1, 2200)]);
      assert.strictEqual(metrics.renders, 1, "concurrent requests should share the expensive PDF render");
      assert.strictEqual(images[0], images[1]);
      const smaller = await viewer.renderSlideForVision(1, 1200);
      assert.notStrictEqual(smaller.data, images[0].data, "different image widths must stay separate");
      await viewer.renderSlideForVision(1);
      assert.strictEqual(metrics.renders, 2, "the default width should reuse the existing image");
      for (let p = 2; p <= 20; p++) await viewer.renderSlideForVision(p);
      const before = metrics.renders;
      await viewer.renderSlideForVision(1);
      assert.strictEqual(metrics.renders, before + 1, "old images should be evicted rather than retained indefinitely");
    }],
    ["retries a failed image preparation", async () => {
      const { viewer, metrics } = viewerHarness();
      metrics.failNextRender = true;
      await assert.rejects(viewer.renderSlideForVision(1), /raster failed/);
      await viewer.renderSlideForVision(1);
      assert.strictEqual(metrics.renders, 2);
    }],
    ["ignores an older failed navigation after a newer page opens", async () => {
      let rejectOld;
      const oldFetch = new Promise((resolve, reject) => { rejectOld = reject; });
      const { viewer, elements } = viewerHarness(url => url === "/lec/1" ? oldFetch :
        Promise.resolve({ ok: true, arrayBuffer: async () => new Uint8Array([2]).buffer }));
      const oldNavigation = viewer.renderMain(1);
      await viewer.renderMain(2);
      rejectOld(new Error("older lecture failed"));
      await oldNavigation;
      assert.strictEqual(elements.get("viewerError").hidden, true, "a stale error must not replace the current page");
      assert.strictEqual(elements.get("pageWrap").hidden, false);
    }],
    ["a failed older render does not block the next page", async () => {
      let rejectRender, releaseFetch, started;
      const oldRender = new Promise((resolve, reject) => { rejectRender = reject; });
      const nextFetch = new Promise(resolve => { releaseFetch = resolve; });
      const renderStarted = new Promise(resolve => { started = resolve; });
      const response = { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      const { viewer, elements } = viewerHarness(url => url === "/lec/1" ? Promise.resolve(response) : nextFetch,
        count => { if (count === 1) started(); return { promise: count === 1 ? oldRender : Promise.resolve(), cancel() {} }; });
      const first = viewer.renderMain(1);
      await renderStarted;
      const second = viewer.renderMain(2);
      rejectRender(new Error("older render failed"));
      await first;
      releaseFetch(response);
      await second;
      assert.strictEqual(elements.get("viewerError").hidden, true);
      assert.strictEqual(elements.get("pageWrap").hidden, false);
    }],
    ["still reports a failure for the current navigation", async () => {
      const { viewer, elements } = viewerHarness(async () => { throw new Error("offline"); });
      await viewer.renderMain(1);
      assert.strictEqual(elements.get("viewerError").hidden, false);
      assert.match(elements.get("viewerError").innerHTML, /offline/);
    }],
  ];
  let failed = 0;
  for (const [name, check] of checks) {
    try { await check(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + ": " + error.message); }
  }
  assert.strictEqual(failed, 0, "viewer behavior checks must pass");
  console.log("client provider checks passed");
}

viewerChecks().catch(error => { console.error(error.message); process.exitCode = 1; });
