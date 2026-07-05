/* ============ DB Slide Finder — UI controller ============
 * Real-time relevance search (SlideSearchEngine) + a pdf.js slide viewer.
 * Lecture PDFs are fetched from a disguised text/plain endpoint (so a download
 * manager can't grab them) and rendered to <canvas> from the in-memory bytes,
 * with matched search terms highlighted on both the main view and thumbnails.
 */
(function () {
  "use strict";

  const DATA_URL = "data/slides.json";
  const AI_PROVIDER = "opus";              // the only model: Anthropic Claude Opus 4.8 (text + high-res vision)
  const VISION_SLIDES = 3; // top slides attached as images for vision grounding
  const VISION_MAX = 4;    // cap incl. extra diagram-heavy slides pulled from ranks 4-6
  const VISION_WIDTH = 2200; // vision render width — within Opus 4.8's 2576px high-res limit, so no API-side downscale
  const THIN_TEXT = 180;   // slides with less extracted text than this are likely pure diagrams (content lives in the image)

  const $ = (id) => document.getElementById(id);
  const qInput = $("q");
  const clearBtn = $("clearBtn");
  const statusEl = $("status");
  const examplesEl = $("examples");
  const resultsEl = $("results");
  const statSlides = $("statSlides");
  const statLectures = $("statLectures");
  const askAiBtn = $("askAiBtn");
  const aiPanel = $("aiPanel");
  const aiBar = $("aiBar");
  const attStrip = $("attStrip");

  const loadingEl = $("loading");
  const viewerError = $("viewerError");
  const canvasScroll = $("canvasScroll");
  const pageWrap = $("pageWrap");
  const canvas = $("pdfCanvas");
  const hlLayer = $("hlLayer");

  const prevBtn = $("prevBtn");
  const nextBtn = $("nextBtn");
  const pageInput = $("pageInput");
  const pageTotalEl = $("pageTotal");
  const tbLecture = $("tbLecture");
  const zoomOutBtn = $("zoomOutBtn");
  const zoomInBtn = $("zoomInBtn");
  const zoomLevel = $("zoomLevel");
  const fitBtn = $("fitBtn");
  const lectureSelect = $("lectureSelect");

  // ---- state ----
  let engine = null;
  let data = null;
  let pdfTotal = 0;
  let pageNum = 1;
  let compiled = null;          // current compiled query (for snippet highlight)
  let pulsePage = 0;            // flash the yellow matches on this page after a citation jump
  let pageToLecture = [];       // pageToLecture[p] = lecture object
  let frameLecture = null;      // lecture number currently shown in the main viewer
  let viewToken = 0;            // cancels superseded navigations
  let mainRenderTask = null;    // current pdf.js render task (cancel on nav)
  let mainScale = 0;            // current effective scale of the main viewer
  let manualZoom = false;       // user has used the zoom buttons
  let zoomAnchor = null;        // cursor-anchored zoom: scroll fixup applied right after the re-render
  let curMainPage = 0, curMainCW = 0, curMainCH = 0;
  const bytesCache = new Map(); // lectureNum -> Promise<Uint8Array>
  const docCache = new Map();   // lectureNum -> Promise<PDFDocumentProxy>
  const pageRenderCache = new Map(); // globalPage -> Promise<{bitmap,cssW,cssH,items}>
  let thumbObserver = null;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function setAiBusy(busy) {
    aiStreaming = !!busy;
    askAiBtn.disabled = !!busy;
    askAiBtn.classList.toggle("busy", !!busy);
  }

  // ===================== init =====================
  async function init() {
    if (location.protocol === "file:") return showFileProtocolHelp();
    try {
      const dataResp = await fetch(DATA_URL, { cache: "no-cache" });
      if (!dataResp.ok) throw new Error("HTTP " + dataResp.status);
      data = await dataResp.json();
    } catch (e) {
      resultsEl.innerHTML = stateMsg("!", "Could not load slide data", "Make sure the local server is running (run <code>start.bat</code>).");
      return;
    }
    if (typeof SlideSearchEngine === "undefined") {
      resultsEl.innerHTML = stateMsg("!", "Search engine failed to load", "Hard-refresh the page or restart the local server.");
      return;
    }
    pdfTotal = data.totalPages;
    allPages = Array.from({ length: pdfTotal }, (_, i) => i + 1);
    buildLectureLookup();
    engine = new SlideSearchEngine(data.slides);

    statSlides.textContent = data.totalPages + " slides";
    statLectures.textContent = data.lectures.length + " lectures";
    pageTotalEl.textContent = data.totalPages;
    pageInput.setAttribute("size", String(data.totalPages).length);
    populateLectureSelect();
    renderEmptyState();
    wireEvents();
    if (typeof pdfjsLib !== "undefined") pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/pdf.worker.min.js";
    else showViewerError("PDF.js could not load", "Search is still available, but the slide viewer needs <code>assets/pdf.min.js</code>.");
    try { if (localStorage.getItem("aiBarVisible") === "1") aiBar.hidden = false; } catch (e) {} // stealth: hidden by default
    try { fastMode = localStorage.getItem("aiFast") === "1"; } catch (e) {}
    try { autoRunSql = localStorage.getItem("aiAutoRun") !== "0"; } catch (e) {} // read-only SQL auto-runs by default
    try { localStorage.removeItem("aiAutoAsk"); } catch (e) {}                   // paste-to-ask was removed — clean up the old flag
    try { checkMode = localStorage.getItem("aiCheck") === "1"; } catch (e) {}    // Gegenprüfung OFF unless :check turned it on
    restoreThread(); // one-shot mode: purges any thread an older build left in localStorage

    document.body.classList.add("stealth"); // keep the brand hidden; sidebar stays visible by default

    const q0 = new URLSearchParams(location.search).get("q");
    if (q0) { revealSearch(false); qInput.value = q0; clearBtn.hidden = false; runSearch(); }

    goToPage(1);
  }

  function buildLectureLookup() {
    pageToLecture = new Array(pdfTotal + 1);
    for (const L of data.lectures) {
      for (let p = L.startPage; p <= L.endPage; p++) pageToLecture[p] = L;
    }
  }
  function populateLectureSelect() {
    for (const L of data.lectures) {
      const o = document.createElement("option");
      o.value = L.startPage;
      o.textContent = L.name;
      lectureSelect.appendChild(o);
    }
  }

  const lectureShort = (L) => (L && L.name ? L.name.split(" · ")[0] : "VL" + (L ? L.num : "?"));
  // slide record for a global page number (slides are page-ordered, so O(1) with a safe fallback)
  const slideByPage = (p) => {
    if (!data) return null;
    const s = data.slides[p - 1];
    if (s && s.page === p) return s;
    return data.slides.find((x) => x && x.page === p) || null;
  };

  // ===================== viewer (pdf.js canvas + highlight overlay) =========
  // Each lecture is fetched once from /lec/<n> (served as text/plain so the
  // download manager ignores it) and rendered with pdf.js from the in-memory
  // bytes — no .pdf URL is ever exposed. Both the main viewer and the result
  // thumbnails render this way, so matched terms can be highlighted on both.
  function getLectureBytes(L) {
    if (!bytesCache.has(L.num)) {
      bytesCache.set(L.num, (async () => {
        const resp = await fetch("/lec/" + L.num, { cache: "no-store" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (!buf.byteLength) throw new Error("empty response (0 bytes)");
        return buf;
      })());
    }
    return bytesCache.get(L.num);
  }
  // pdf.js document for a lecture (for rendering thumbnails). Parse on the main
  // thread (~120 ms, cached once per lecture) — predictable, no worker stalls.
  function getLectureDoc(L) {
    if (!docCache.has(L.num)) {
      docCache.set(L.num, getLectureBytes(L).then((buf) =>
        pdfjsLib.getDocument({ data: buf.slice(), disableWorker: true }).promise));
    }
    return docCache.get(L.num);
  }

  async function cancelMainRender() {
    const task = mainRenderTask;
    if (!task) return;
    mainRenderTask = null;
    try { task.cancel(); } catch (e) {}
    try { await task.promise; }
    catch (e) { if (!e || e.name !== "RenderingCancelledException") throw e; }
  }

  const THUMB_W = 700; // render width (px) — displayed scaled, stays crisp
  // Render a slide to a bitmap once (cached). Highlight geometry is computed
  // separately by getWordBoxes, so the main viewer can highlight without
  // re-rendering a thumbnail bitmap.
  function getPageRender(globalPage) {
    if (!pageRenderCache.has(globalPage)) {
      pageRenderCache.set(globalPage, (async () => {
        const L = pageToLecture[globalPage];
        const doc = await getLectureDoc(L);
        const page = await doc.getPage(globalPage - L.startPage + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = THUMB_W / base.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(canvas) : canvas;
        return { bitmap, cssW: vp.width, cssH: vp.height };
      })());
    }
    return pageRenderCache.get(globalPage);
  }

  const fold = (w) => (typeof SlideSearchEngine.fold === "function" ? SlideSearchEngine.fold(w) : w.toLowerCase());

  // Render a slide to a JPEG data payload for the vision model. Rendered fresh at
  // a higher resolution than the thumbnail so diagrams/ER-models/SQL stay legible.
  // Opus 4.8 accepts up to 2576px on the long edge without server-side downscaling,
  // so everything rendered at VISION_WIDTH reaches the model pixel-for-pixel.
  async function renderSlideForVision(globalPage, width) {
    const L = pageToLecture[globalPage];
    const doc = await getLectureDoc(L);
    const page = await doc.getPage(globalPage - L.startPage + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = (width || VISION_WIDTH) / base.width;
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const url = c.toDataURL("image/jpeg", 0.85);
    return { media_type: "image/jpeg", data: url.split(",")[1] };
  }

  // Per-word highlight geometry in NORMALIZED page coords (0..1), computed once
  // per slide from the pdf.js text layer at scale 1. Because each box is a
  // fraction of the page, the same data positions a highlight correctly at any
  // zoom or thumbnail size when placed with CSS percentages — no drift. (This is
  // why the old absolute-pixel overlay was removed; this approach replaces it.)
  // Within a text run we split into words and map each word's offset onto the
  // run's true rendered width via canvas measureText, so highlights hug the word.
  const wordBoxCache = new Map();
  function getWordBoxes(globalPage) {
    if (!wordBoxCache.has(globalPage)) {
      wordBoxCache.set(globalPage, (async () => {
        const L = pageToLecture[globalPage];
        const doc = await getLectureDoc(L);
        const page = await doc.getPage(globalPage - L.startPage + 1);
        const vp = page.getViewport({ scale: 1 });
        const pageW = vp.width || 1, pageH = vp.height || 1;
        const boxes = [];
        const meas = document.createElement("canvas").getContext("2d");
        const RE = /[\p{L}\p{N}]+/gu;
        try {
          const tc = await page.getTextContent();
          const styles = tc.styles || {};
          for (const it of tc.items) {
            const str = it.str || "";
            if (!str.trim()) continue;
            const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
            const fontH = Math.hypot(tx[2], tx[3]) || 10;
            const x0 = tx[4], yTop = tx[5] - fontH;
            const runW = it.width || 0; // already in scale-1 page units
            // measure with the run's real font family (serif/sans/mono from the
            // pdf.js style map) — proportions match the PDF better than a fixed
            // sans-serif guess, so per-word boxes hug the words more tightly
            const fam = (styles[it.fontName] && styles[it.fontName].fontFamily) || "sans-serif";
            meas.font = fontH + "px " + fam;
            const full = meas.measureText(str).width || 1;
            const k = runW > 0 ? runW / full : 0; // map our metrics onto the true run width
            let m; RE.lastIndex = 0;
            while ((m = RE.exec(str)) !== null) {
              const pre = meas.measureText(str.slice(0, m.index)).width;
              const wpx = meas.measureText(m[0]).width;
              boxes.push({
                f: fold(m[0]),
                x: (x0 + pre * k) / pageW,
                y: yTop / pageH,
                w: (wpx * k) / pageW,
                h: (fontH * 1.18) / pageH,
              });
            }
          }
        } catch (e) {}
        return { boxes };
      })());
    }
    return wordBoxCache.get(globalPage);
  }

  // Paint yellow highlight boxes (CSS-% divs) for every word whose folded form is
  // in the compiled query. Scale-independent: the layer only needs to be
  // position:absolute; inset:0 over a box the size of the rendered slide.
  function placeHighlights(layerEl, wb, cq) {
    if (!layerEl) return;
    layerEl.innerHTML = "";
    if (!wb || !cq || !cq.hitSet || !cq.hitSet.size) return;
    const frag = document.createDocumentFragment();
    for (const b of wb.boxes) {
      if (b.w <= 0 || !cq.hitSet.has(b.f)) continue;
      const d = document.createElement("div");
      d.className = "hl-box";
      d.style.cssText = "left:" + (b.x * 100) + "%;top:" + (b.y * 100) + "%;width:" + (b.w * 100) + "%;height:" + (b.h * 100) + "%";
      frag.appendChild(d);
    }
    layerEl.appendChild(frag);
  }

  // ===================== region snip → ask (Alt+drag / ✂) ==================
  // Draw a box on the slide (hold Alt and drag, or arm once via the ✂ button):
  // that region is cut out of a fresh high-res render and queued as an image
  // question — the tutor is told which Folie the snippet came from, so the
  // answer is grounded in that slide's text AND its pixels.
  let snipArm = false;
  let snipMarq = null;
  function setSnipArm(on) {
    snipArm = !!on;
    canvasScroll.classList.toggle("snip-armed", snipArm);
    const b = $("snipBtn");
    if (b) b.classList.toggle("tb-on", snipArm);
  }
  async function snipRegion(page, nx, ny, nw, nh) {
    const L = pageToLecture[page];
    const doc = await getLectureDoc(L);
    const pg = await doc.getPage(page - L.startPage + 1);
    const base = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: VISION_WIDTH / base.width }); // crop from a vision-quality render, not the screen canvas
    const full = document.createElement("canvas");
    full.width = Math.floor(vp.width); full.height = Math.floor(vp.height);
    await pg.render({ canvasContext: full.getContext("2d"), viewport: vp }).promise;
    const cx = Math.round(nx * full.width), cy = Math.round(ny * full.height);
    const cw = Math.max(8, Math.round(nw * full.width)), ch = Math.max(8, Math.round(nh * full.height));
    const out = document.createElement("canvas");
    out.width = cw; out.height = ch;
    out.getContext("2d").drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
    const dataUrl = out.toDataURL("image/png");
    return { media_type: "image/png", data: dataUrl.split(",")[1], dataUrl: dataUrl, page: page };
  }
  function wireSnip() {
    pageWrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !(e.altKey || snipArm)) return;
      e.preventDefault();
      const page = pageNum;
      const r0 = pageWrap.getBoundingClientRect();
      const sx = e.clientX - r0.left, sy = e.clientY - r0.top;
      if (!snipMarq) { snipMarq = document.createElement("div"); snipMarq.className = "snip-marq"; }
      pageWrap.appendChild(snipMarq);
      const set = (x, y, w, h) => { snipMarq.style.cssText = "left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px"; };
      set(sx, sy, 0, 0);
      const clampTo = (ev, r) => [
        Math.min(Math.max(ev.clientX - r.left, 0), r.width),
        Math.min(Math.max(ev.clientY - r.top, 0), r.height),
      ];
      const move = (ev) => {
        const r = pageWrap.getBoundingClientRect();
        const c = clampTo(ev, r);
        set(Math.min(sx, c[0]), Math.min(sy, c[1]), Math.abs(c[0] - sx), Math.abs(c[1] - sy));
      };
      const up = async (ev) => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const r = pageWrap.getBoundingClientRect();
        const c = clampTo(ev, r);
        const x = Math.min(sx, c[0]), y = Math.min(sy, c[1]);
        const w = Math.abs(c[0] - sx), h = Math.abs(c[1] - sy);
        try { snipMarq.remove(); } catch (e2) {}
        setSnipArm(false);
        if (w < 16 || h < 16) return; // treat as a mis-click, not a snip
        if (pendingImages.length >= 4) { showAiToast("max. 4 Anhänge"); return; }
        showAiToast("Ausschnitt wird erstellt…");
        try {
          const im = await snipRegion(page, x / r.width, y / r.height, w / r.width, h / r.height);
          pendingImages.push(im);
          renderAttachments();
          revealSearch(true);
          showAiToast("Ausschnitt von Folie " + page + " angehängt — Frage tippen · Enter");
        } catch (e2) { showAiToast("Ausschnitt fehlgeschlagen"); }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  async function renderCardThumb(card, globalPage, cq) {
    const canvas = card.querySelector(".rc-canvas");
    const hl = card.querySelector(".rc-hl");
    if (!canvas) return;
    let r;
    try { r = await getPageRender(globalPage); }
    catch (e) { card.classList.add("thumb-failed"); return; }
    if (!card.isConnected) return;
    canvas.width = r.bitmap.width; canvas.height = r.bitmap.height;
    canvas.getContext("2d").drawImage(r.bitmap, 0, 0);
    card.classList.add("thumb-ready");
    if (hl) {
      if (cq) { try { const wb = await getWordBoxes(globalPage); if (card.isConnected) placeHighlights(hl, wb, cq); } catch (e) {} }
      else hl.innerHTML = "";
    }
  }

  async function renderMain(num) {
    const L = pageToLecture[num];
    if (!L) return;
    if (typeof pdfjsLib === "undefined") {
      showViewerError("PDF.js could not load", "Search is still available, but the slide viewer needs <code>assets/pdf.min.js</code>.");
      return;
    }
    const token = ++viewToken;
    if (frameLecture !== L.num) { loadingEl.hidden = false; viewerError.hidden = true; pageWrap.hidden = true; }
    let doc;
    try {
      doc = await getLectureDoc(L);
    } catch (e) {
      bytesCache.delete(L.num); docCache.delete(L.num);
      const detail = e ? (e.name || "Error") + ": " + (e.message || e) : "unknown";
      return showViewerError("Could not load " + lectureShort(L), "Search still works.<br><small style='color:#9aa6b2'>" + esc(detail) + "</small>");
    }
    if (token !== viewToken) return;
    frameLecture = L.num;
    let page;
    try { page = await doc.getPage(num - L.startPage + 1); }
    catch (e) {
      return showViewerError("Could not open Folie " + num, esc((e && e.message) || e || "unknown error"));
    }
    if (token !== viewToken) return;
    try { await cancelMainRender(); }
    catch (e) {
      return showViewerError("Could not reset renderer", esc((e && e.message) || e || "unknown error"));
    }
    if (token !== viewToken) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const base = page.getViewport({ scale: 1 });
    const avail = Math.max(canvasScroll.clientWidth - 48, 240);
    const scale = manualZoom && mainScale ? mainScale : avail / base.width;
    mainScale = scale;
    const vp = page.getViewport({ scale });
    const cw = Math.floor(vp.width), ch = Math.floor(vp.height);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
    pageWrap.style.width = cw + "px"; pageWrap.style.height = ch + "px";

    mainRenderTask = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    try { await mainRenderTask.promise; }
    catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      mainRenderTask = null;
      return showViewerError("Could not render Folie " + num, esc((e && e.message) || e || "unknown error"));
    }
    if (token !== viewToken) return;
    mainRenderTask = null;
    loadingEl.hidden = true; pageWrap.hidden = false;
    if (zoomAnchor) { // keep the point under the cursor stationary across the zoom re-render
      const z = zoomAnchor; zoomAnchor = null;
      canvasScroll.scrollLeft = (z.sx + z.ax) * z.ratio - z.ax;
      canvasScroll.scrollTop = (z.sy + z.ay) * z.ratio - z.ay;
    }
    zoomLevel.textContent = Math.round(scale * 100) + "%";
    curMainPage = num; curMainCW = cw; curMainCH = ch;
    drawMainHighlights(num);
  }

  // Zoom the main viewer by `factor`, anchored at a viewport point (Ctrl+wheel,
  // trackpad pinch, or the +/- buttons anchored at the center). Rapid wheel ticks
  // compound into one pending anchor so the scroll fixup stays consistent even
  // when intermediate renders get cancelled.
  function zoomAt(factor, clientX, clientY) {
    if (!curMainPage) return;
    const old = mainScale || 1;
    const ns = Math.min(8, Math.max(0.2, old * factor));
    if (ns === old) return;
    manualZoom = true;
    const r = canvasScroll.getBoundingClientRect();
    const ax = clientX - r.left, ay = clientY - r.top;
    if (zoomAnchor) { zoomAnchor.ratio *= ns / old; zoomAnchor.ax = ax; zoomAnchor.ay = ay; }
    else zoomAnchor = { ratio: ns / old, ax, ay, sx: canvasScroll.scrollLeft, sy: canvasScroll.scrollTop };
    mainScale = ns;
    renderMain(pageNum);
  }

  // Yellow match overlay on the main viewer. Uses the normalized word boxes
  // placed with CSS %, so it tracks the canvas exactly at any zoom. (The old
  // pixel-based overlay drifted into wide misplaced bands and was removed; this
  // normalized version does not drift, so highlighting is back on the main view.)
  async function drawMainHighlights(num) {
    if (!hlLayer) return;
    hlLayer.innerHTML = "";
    if (!compiled || typeof pdfjsLib === "undefined") return;
    try {
      const wb = await getWordBoxes(num);
      if (curMainPage === num && compiled) placeHighlights(hlLayer, wb, compiled);
      if (pulsePage === num) { // arrived via a citation link → softly pulse the matches
        pulsePage = 0;
        hlLayer.classList.add("hl-pulse");
        setTimeout(() => hlLayer.classList.remove("hl-pulse"), 1400);
      }
    } catch (e) {}
  }
  function redrawMainHighlights() { drawMainHighlights(curMainPage || pageNum); }

  function goToPage(num) {
    num = Math.max(1, Math.min(pdfTotal, num | 0));
    pageNum = num;
    pageInput.value = num;
    updateLectureLabel(num);
    updateNav();
    syncActiveCard(num);
    renderMain(num);
  }
  function updateNav() {
    prevBtn.disabled = pageNum <= 1;
    nextBtn.disabled = pageNum >= pdfTotal;
  }
  function updateLectureLabel(num) {
    const L = pageToLecture[num];
    tbLecture.textContent = L ? L.name + "  ·  Folie " + (num - L.startPage + 1) + "/" + L.pages : "";
    if (L) lectureSelect.value = L.startPage;
  }

  // ===================== search =====================
  let searchTimer = null;
  function onInput() {
    clearBtn.hidden = qInput.value.length === 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 90); // real-time, no Enter needed
  }
  function runSearch() {
    if (!engine) return;
    const query = qInput.value.trim();
    syncUrl(query);
    if (!query) { compiled = null; renderPageList(allPages, null); redrawMainHighlights(); return; }
    const res = engine.search(query, { limit: 48 });
    compiled = res.compiled;
    renderPageList(res.results, res.compiled);
    redrawMainHighlights();
  }
  function syncUrl(query) {
    try {
      const u = new URL(location.href);
      if (query) u.searchParams.set("q", query);
      else u.searchParams.delete("q");
      history.replaceState(null, "", u);
    } catch (e) {}
  }

  // ---- Adobe-style page thumbnail panel -----------------------------------
  let allPages = []; // [1..totalPages], built in init
  // Two modes: a plain page navigator (entries = page numbers, cq null) and rich
  // search results (entries = engine result objects with snippet/score, cq set).
  function renderPageList(entries, cq) {
    examplesEl.hidden = true;
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (!entries.length) { resultsEl.innerHTML = stateMsg("🔍", "Keine Treffer", "Andere Begriffe versuchen."); return; }
    const rich = !!cq;
    if (typeof pdfjsLib !== "undefined" && "IntersectionObserver" in window) {
      thumbObserver = new IntersectionObserver((obsEntries, obs) => {
        for (const e of obsEntries) if (e.isIntersecting) {
          obs.unobserve(e.target);
          renderCardThumb(e.target, +e.target.dataset.page, cq);
        }
      }, { root: resultsEl, rootMargin: "700px 0px" });
    }
    const frag = document.createDocumentFragment();
    const cards = [];
    entries.forEach((entry) => {
      const p = typeof entry === "number" ? entry : entry.page;
      const card = document.createElement("button");
      card.className = rich ? "pg-thumb result" : "pg-thumb";
      card.dataset.page = p;
      let html = '<div class="pg-img"><canvas class="rc-canvas"></canvas><div class="rc-hl"></div></div>';
      if (rich) {
        const L = pageToLecture[p];
        const pct = Math.max(6, Math.round((entry.norm || 0) * 100));
        const snip = engine.highlightHTML(entry.snippet || "", cq);
        html += '<div class="rc-meta"><div class="rc-top">' +
                '<span class="rc-page">Folie ' + p + '</span>' +
                '<span class="rc-lecture">' + esc(L ? lectureShort(L) : "") + '</span>' +
                '<span class="rc-bar"><i style="width:' + pct + '%"></i></span></div>' +
                '<div class="rc-snippet">' + snip + '</div></div>';
      } else {
        html += '<div class="pg-num">' + p + '</div>';
      }
      card.innerHTML = html;
      card.addEventListener("click", () => { goToPage(p); });
      frag.appendChild(card);
      cards.push(card);
    });
    resultsEl.innerHTML = "";
    resultsEl.appendChild(frag);
    const EAGER = 5;
    if (typeof pdfjsLib !== "undefined") {
      if (thumbObserver) cards.forEach((c, i) => { if (i >= EAGER) thumbObserver.observe(c); });
      for (let i = 0; i < Math.min(cards.length, EAGER); i++) renderCardThumb(cards[i], +cards[i].dataset.page, cq);
    }
    resultsEl.scrollTop = 0;
    syncActiveCard(pageNum);
  }

  function setActiveCard(card) {
    resultsEl.querySelectorAll(".pg-thumb.active").forEach((c) => c.classList.remove("active"));
    if (card) card.classList.add("active");
  }
  function syncActiveCard(num) {
    let match = null;
    resultsEl.querySelectorAll(".pg-thumb").forEach((c) => { if (+c.dataset.page === num) match = c; });
    setActiveCard(match);
    if (match) match.scrollIntoView({ block: "nearest" });
  }

  function renderEmptyState() {
    // default: every page as a preview thumbnail (PDF page navigator)
    renderPageList(allPages.length ? allPages : [], null);
  }
  function stateMsg(ico, h, p) {
    return '<div class="state-msg"><div class="ico" style="font-size:34px">' + ico + "</div><h3>" + h + "</h3><p>" + p + "</p></div>";
  }

  // ===================== hidden tutor chat (streaming markdown notes) ======
  let aiThread = [];        // [{role:'user'|'assistant', content, q}] — persists across asks (short memory); :new clears it
  let aiStreaming = false;
  let fastMode = false;     // :fast → text-only (no slide images) for a quick answer
  let autoRunSql = true;    // :auto → read-only SQL in answers runs by itself against the imported DB
  let checkMode = false;    // OFF by default — no automatic Gegenprüfung; :check opts back in (⟳ Prüfen stays manual)
  let askQueue = [];        // questions pasted while one is streaming wait here and fire automatically
  let streamBodyEl = null;  // the DOM node of the currently-streaming answer
  let pendingImages = [];   // pasted screenshots queued for the next ask {media_type,data,dataUrl}
  let pendingFiles = [];    // pasted text/SQL files queued for the next ask {name,text,truncated}

  function revealSearch(shouldFocus) {
    document.body.classList.remove("viewer-only");
    if (shouldFocus !== false) qInput.focus();
  }
  // Esc closes ONLY the tutor notes (plus hover previews and toasts) and
  // returns to the normal search+viewer UI — the sidebar stays visible.
  // The sandbox is left alone; it closes via its own Esc or the SQL button.
  function panicHide() {
    try { hideRefPreview(); } catch (e) {}
    if (!aiPanel.hidden) closeChat();
    revealSearch(false); // normal mode — no focus grab
    const t = document.getElementById("aiToast");
    if (t) t.classList.remove("show");
  }

  function openChat() { revealSearch(false); examplesEl.hidden = true; resultsEl.hidden = true; aiPanel.hidden = false; }
  function closeChat() {
    aiPanel.hidden = true;
    resultsEl.hidden = false;
    if (!resultsEl.querySelector(".pg-thumb")) renderEmptyState();
    qInput.focus();
  }

  // ---- pasted screenshots ---------------------------------------------------
  // Downscale a pasted image blob → {media_type, data(base64, no prefix), dataUrl}.
  function processImageBlob(blob, maxDim) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const s = Math.min(1, (maxDim || 1400) / Math.max(w, h));
        w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/png");
        resolve({ media_type: "image/png", data: dataUrl.split(",")[1], dataUrl: dataUrl });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }
  // ---- pasted text / SQL files ---------------------------------------------
  // A file copied from the OS (e.g. a .sql script) is attached as context for the
  // next ask, just like a screenshot — read as text, never run, sent to the tutor.
  const TEXT_FILE_RE = /\.(sql|ddl|pgsql|mysql|txt|csv|tsv|json|md|log|xml|yaml|yml)$/i;
  function isTextFile(f) {
    const name = (f && f.name || "").toLowerCase();
    if (TEXT_FILE_RE.test(name)) return true;
    const t = (f && f.type || "").toLowerCase();
    return t.indexOf("text/") === 0 || t === "application/sql" || t === "application/json" || t === "application/xml";
  }
  function processTextFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        let text = String(r.result || "");
        const MAX = 200000; // cap context size; truncate huge files with a note
        const truncated = text.length > MAX;
        if (truncated) text = text.slice(0, MAX);
        resolve({ name: (file.name || "datei.txt"), text: text, truncated: truncated });
      };
      r.onerror = () => reject(new Error("read failed"));
      r.readAsText(file);
    });
  }

  // One paste pipeline for the whole app (search box AND anywhere else):
  // images/files attach as chips, text goes to live search. Pasting can NEVER
  // reach the tutor — asking requires the chords or the Ask button.
  async function handlePaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const fromInput = e.target === qInput;
    const imgBlobs = [], textBlobs = [], seen = new Set();
    const consider = (f) => {
      if (!f) return;
      const key = (f.name || "") + ":" + f.size;     // copied files appear in both items & files
      if (seen.has(key)) return; seen.add(key);
      if (f.type && f.type.indexOf("image") === 0) imgBlobs.push(f);
      else if (isTextFile(f)) textBlobs.push(f);
    };
    for (const it of (cd.items || [])) { if (it.kind === "file") consider(it.getAsFile()); }
    for (const f of (cd.files || [])) consider(f);

    if (!imgBlobs.length && !textBlobs.length) {
      // plain text is only ever a search — never a question to the tutor
      const txt = (cd.getData && cd.getData("text/plain")) || "";
      if (!fromInput && txt.trim()) {
        e.preventDefault();
        revealSearch(true);
        qInput.value = txt.trim().slice(0, 300);
        onInput();
      }
      return; // paste into the search box falls through to normal typing/search
    }

    e.preventDefault();
    for (const f of imgBlobs) {
      if (pendingImages.length >= 4) break;
      // 2400px keeps even high-DPI screenshots under Opus 4.8's 2576px vision
      // limit without the API downscaling them — small exam text stays readable
      try { pendingImages.push(await processImageBlob(f, 2400)); } catch (err) {}
    }
    for (const f of textBlobs) {
      if (pendingFiles.length >= 4) break;
      try { pendingFiles.push(await processTextFile(f)); } catch (err) {}
    }
    renderAttachments();
    if (!fromInput && (pendingImages.length || pendingFiles.length)) revealSearch(false);
    // attachments just wait as chips — sending them takes an explicit chord/button
  }

  // Discreet attachment strip: thumbnails of queued screenshots + chips for queued
  // text/SQL files, each removable. Shown above the search box before an ask.
  function renderAttachments() {
    if (!attStrip) return;
    attStrip.innerHTML = "";
    attStrip.hidden = pendingImages.length === 0 && pendingFiles.length === 0;
    pendingImages.forEach((im, i) => {
      const t = document.createElement("span");
      t.className = "att-thumb";
      t.innerHTML = '<img src="' + im.dataUrl + '" alt=""><button class="att-x" title="Entfernen" aria-label="Entfernen">&times;</button>';
      t.querySelector(".att-x").addEventListener("click", () => { pendingImages.splice(i, 1); renderAttachments(); });
      attStrip.appendChild(t);
    });
    pendingFiles.forEach((f, i) => {
      const t = document.createElement("span");
      t.className = "att-file";
      t.title = f.name + (f.truncated ? " (gekürzt)" : "");
      const label = document.createElement("span");
      label.className = "att-file-name";
      label.textContent = "📄 " + f.name;            // textContent → no HTML injection from filename
      const x = document.createElement("button");
      x.className = "att-x"; x.title = "Entfernen"; x.setAttribute("aria-label", "Entfernen"); x.innerHTML = "&times;";
      x.addEventListener("click", () => { pendingFiles.splice(i, 1); renderAttachments(); });
      t.appendChild(label); t.appendChild(x);
      attStrip.appendChild(t);
    });
  }

  // ONE-SHOT mode: notes are never stored. persistThread actively deletes any
  // previously saved thread (cleans up storage left by older builds too), and a
  // reload starts blank — nothing about past questions survives in localStorage.
  const THREAD_KEY = "ntThread";
  function persistThread() {
    try { localStorage.removeItem(THREAD_KEY); } catch (e) {}
  }
  function restoreThread() {
    try { localStorage.removeItem(THREAD_KEY); } catch (e) {}
  }

  // POST to the tutor endpoint with one silent retry when nothing has been
  // received yet (exam-day resilience: a flaky first connection self-heals).
  async function postQ(messages, effort) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch("q", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: AI_PROVIDER, messages: messages, effort: effort }),
        });
        if (!resp.ok || !resp.body) {
          const e = await resp.json().catch(() => ({}));
          throw new Error(e.error || "Request failed (HTTP " + resp.status + ")");
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw lastErr || new Error("Anfrage fehlgeschlagen");
  }
  async function readAll(resp) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let acc = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
    }
    return acc;
  }

  // ===================== Gegenprüfung (silent self-verification) ============
  // Every answer is re-solved from scratch by an independent second request
  // (self-consistency: two agreeing independent solves are far more reliable
  // than one). On agreement a subtle "✓✓" chip appears. On DISAGREEMENT a
  // strict third arbiter solve decides 2-of-3 — so a wrong "correction" can't
  // flip a right answer (the classic self-correction failure on multiple
  // choice). If the answer contains read-only SQL and an exam DB is loaded,
  // the checker additionally receives the REAL execution result as evidence.
  // Runs detached: never blocks or disturbs the visible answer. :check toggles.
  const CHECK_LABEL = {
    checking: "· wird gegengeprüft…",
    appeal: "· wird gegengeprüft… (Einspruch läuft)",
    ok: "✓✓ gegengeprüft",
    ok2: "✓ bestätigt (2 von 3)",
    fixed: "⚠ korrigiert (2 von 3)",
    warn: "⚠ Zweitlösung weicht ab",
  };
  function ensureCheckChip(el, turn, state) {
    // terminal states (ok/ok2/fixed/warn) are written to turn.check by the
    // callers; transient states (checking/appeal) are DOM-only
    if (!el || !el.isConnected) return;
    let chip = el.querySelector(".nt-check");
    if (!state) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "nt-check";
      const bar = el.querySelector(".nt-actions");
      if (bar) bar.appendChild(chip); else el.appendChild(chip);
    }
    chip.dataset.state = state;
    chip.textContent = CHECK_LABEL[state] || "";
  }
  // Compact execution evidence for SQL answers (read-only, imported DB only).
  async function sqlEvidenceFor(content) {
    let evidence = "";
    try {
      if (!window.SqlSandbox || !SqlSandbox.execForCheck || !window.SqlUtil) return "";
      const schema = await SqlSandbox.schemaText();
      if (!schema) return "";
      const re = /```(?:sql|mysql|sqlite)\r?\n([\s\S]*?)```/gi;
      let m, n = 0;
      while ((m = re.exec(content)) !== null && n < 2) {
        const sql = m[1].trim();
        const stmts = SqlUtil.splitStatements(sql);
        if (!stmts.length || stmts.length > 2) continue;
        if (!stmts.every((s) => READONLY_SQL.test(s.trim()) && !WRITE_SQL.test(s))) continue;
        n++;
        evidence += "\n\n--- AUSFÜHRUNGSBELEG (diese Abfrage wurde real auf der importierten DB ausgeführt) ---\n" +
          (await SqlSandbox.execForCheck(sql));
      }
    } catch (e) {}
    return evidence;
  }
  // Endergebnis-level normalization: two independently generated answers that
  // are textually identical after stripping citations/markdown ARE the same
  // result — that agreement is free (no comparison call needed).
  function normalizeVerdictText(s) {
    return String(s || "")
      .replace(/\(Folie[^)]*\)/gi, "")
      .replace(/\(allg\.?[^)]*\)/gi, "")
      .replace(/[*_`#>~|]/g, "")
      .replace(/\s+/g, " ")
      .trim().toLowerCase();
  }
  async function crossCheckAnswer(turn, blocks, el, shadowPromise) {
    ensureCheckChip(el, turn, "checking");
    try {
      const shadow = String((await shadowPromise) || "").trim();
      if (!shadow || shadow.indexOf("_(Fehler") !== -1) { ensureCheckChip(elForTurn(turn, el), turn, ""); return; }
      // 1) free agreement: normalized-identical answers confirm instantly
      const a = normalizeVerdictText(turn.content), b = normalizeVerdictText(shadow);
      if (a && a === b) { finishCheck(turn, el, "ok"); return; }
      // 2) quick semantic compare of the two END RESULTS (tiny output, medium effort)
      const cmpBlocks = blocks.concat([{ type: "text", text:
        "\n--- LÖSUNG A ---\n" + turn.content + "\n--- LÖSUNG B ---\n" + shadow + "\n--- ENDE ---\n" +
        "Vergleiche NUR die Endergebnisse der beiden unabhängigen Lösungen (Formulierung ist egal; bei mehreren " +
        'Teilaufgaben müssen ALLE Teilergebnisse übereinstimmen). Antworte GENAU "GLEICH" oder GENAU "VERSCHIEDEN".' }]);
      const cmp = String(await readAll(await postQ([{ role: "user", content: cmpBlocks }], "medium")) || "").trim();
      if (/^[\s*_#>"']*gleich\b/i.test(cmp)) { finishCheck(turn, el, "ok"); return; }
      // 3) real conflict → strict arbiter at maximum depth decides 2-of-3, with
      // real SQL execution evidence when available; only a majority may correct
      ensureCheckChip(elForTurn(turn, el), turn, "appeal");
      const evidence = await sqlEvidenceFor(turn.content);
      const adjBlocks = blocks.concat([{ type: "text", text:
        "\n--- LÖSUNG A ---\n" + turn.content + "\n--- LÖSUNG B ---\n" + shadow + "\n--- ENDE ---" + evidence + "\n\n" +
        "Schiedsprüfung: Zwei unabhängige Lösungen widersprechen sich im Endergebnis. Löse die Aufgabe selbst und " +
        'entscheide streng. ERSTE Zeile deiner Antwort: genau "A" oder "B" (welches Endergebnis korrekt ist). ' +
        'Ab der zweiten Zeile: nur bei "B" die korrekte Kurzantwort.' }]);
      // the arbiter decides whether an answer gets corrected → maximum depth
      const adj = String(await readAll(await postQ([{ role: "user", content: adjBlocks }], "xhigh")) || "").trim();
      const firstLine = (adj.split(/\r?\n/)[0] || "").replace(/[*_#>."'`:]/g, "").trim().toUpperCase();
      if (/^A\b/.test(firstLine) || firstLine === "A") { finishCheck(turn, el, "ok2"); return; }
      const corr = adj.replace(/^.*(\r?\n|$)/, "").trim() || shadow;
      applyCorrection(turn, el, corr, /^B\b/.test(firstLine) || firstLine === "B" ? "fixed" : "warn");
    } catch (e) {
      ensureCheckChip(elForTurn(turn, el), turn, ""); // silent — verification must never disturb the answer
    }
  }
  // The thread may have re-rendered while a check ran (queued questions) —
  // re-resolve the turn's current DOM element so the verdict still lands.
  function elForTurn(turn, el) {
    if (el && el.isConnected) return el;
    const doc = aiPanel.querySelector("#ntDoc");
    if (!doc) return null;
    const i = aiThread.indexOf(turn); // renderThread appends exactly one div per turn
    return i >= 0 ? (doc.children[i] || null) : null;
  }
  function finishCheck(turn, el, state) {
    turn.check = state;
    ensureCheckChip(elForTurn(turn, el), turn, state);
    persistThread();
  }
  function applyCorrection(turn, el, correction, state) {
    turn.check = state;
    turn.content += "\n\n---\n\n**⚠ Gegenprüfung — Korrektur:**\n\n" + correction;
    el = elForTurn(turn, el);
    if (el) {
      el.innerHTML = renderMarkdown(turn.content);
      enhanceAnswer(el);
      addAnswerActions(el, turn);
      ensureCheckChip(el, turn, state);
      const doc = aiPanel.querySelector("#ntDoc");
      if (doc) doc.scrollTop = doc.scrollHeight;
    }
    persistThread();
  }

  async function runAsk() {
    const q = qInput.value.trim();
    const imgs = pendingImages.slice();              // screenshots the user pasted
    const files = pendingFiles.slice();              // .sql/text files the user pasted
    if ((!q && !imgs.length && !files.length) || !engine) return;
    if (aiStreaming) {
      // rapid-fire exam flow: questions pasted while one is streaming queue up
      // and fire automatically as soon as the current answer is done
      askQueue.push({ q: q, imgs: imgs, files: files });
      qInput.value = ""; clearBtn.hidden = true;
      pendingImages = []; pendingFiles = []; renderAttachments();
      showAiToast("⏳ eingereiht (" + askQueue.length + ")");
      return;
    }
    setAiBusy(true);
    const isImageAsk = imgs.length > 0;              // pasted screenshot → the image IS the full question
    let assistantTurn = null;

    try {
      // The only model is Claude Opus 4.8 (multimodal: text + screenshots).
      const provider = AI_PROVIDER;

      // BM25 slide text is for TEXT questions only.
      // A pasted screenshot is self-contained, so we send just the image — no slides.
      let citationSlides = [];
      let slidesText = "";
      let visionImages = [];     // rendered top-slide images {page, media_type, data} (vision grounding)
      if (q && !isImageAsk) {
        const res = engine.search(q, { limit: 12 });
        const pickedSlides = res.results.slice(0, 12);
        citationSlides = pickedSlides.map((r) => data.slides[r.docId]).filter(Boolean);
        // Which slides go along as IMAGES: the top-ranked ones, plus any near-top
        // slide whose extracted text is so thin its content must live in the
        // graphics (ER diagram, table screenshot). :fast turns images off.
        // PASTED exam tasks (long q) are self-contained — slide images only pay
        // off when the slides genuinely match, so weak matches skip the whole
        // render+upload+vision cost (several seconds) and strong matches send
        // just the single best slide as grounding.
        let visionPages = [];
        if (!fastMode && typeof pdfjsLib !== "undefined") {
          const top = res.results[0];
          const pastedTask = q.length >= 160;
          if (pastedTask) {
            if (top && (top.coverage || 0) >= 0.5) visionPages = [top.page];
          } else {
            visionPages = pickedSlides.slice(0, VISION_SLIDES).map((r) => r.page);
            for (const r of pickedSlides.slice(VISION_SLIDES, 6)) {
              if (visionPages.length >= VISION_MAX) break;
              const t = ((((data.slides[r.docId] || {}).text) || "")).replace(/\s+/g, " ").trim();
              if (t.length < THIN_TEXT) visionPages.push(r.page);
            }
          }
        }
        slidesText = pickedSlides.map((r) =>
          "[Folie " + r.page + " | " + (r.lecture || "") + " | " + (r.title || "") +
          (visionPages.indexOf(r.page) >= 0 ? " | auch als Bild beigefügt" : "") + "]\n" +
          (((data.slides[r.docId] || {}).text) || "").slice(0, 1000)
        ).join("\n\n");
        visionImages = (await Promise.all(visionPages.map((pg) =>
          renderSlideForVision(pg, VISION_WIDTH)
            .then((im) => ({ page: pg, media_type: im.media_type, data: im.data }))
            .catch(() => null)
        ))).filter(Boolean);
      }

      // attached .sql/text files → a context block appended to the prompt
      let filesText = "";
      if (files.length) {
        filesText = "\n\n--- Angehängte Datei(en) (vom Nutzer eingefügt) ---\n" +
          files.map((f) => "### " + f.name + (f.truncated ? " (gekürzt)" : "") + "\n" + f.text).join("\n\n");
      }

      // imported DB schema + active dialect — sent with EVERY ask (screenshots too:
      // a photographed SQL task still needs the real table/column names to be solvable)
      let schemaBlock = "";
      try {
        if (window.SqlSandbox && SqlSandbox.schemaText) {
          const schema = await SqlSandbox.schemaText();
          if (schema) {
            const dialect = (SqlSandbox.engineName && SqlSandbox.engineName()) || "SQL";
            schemaBlock = "\n\n--- Importiertes Datenbank-Schema (Dialekt: " + dialect +
              " — nutze GENAU diese Tabellen-/Spaltennamen) ---\n" + schema;
          }
        }
      } catch (e) {}

      // text block: for an image ask, request a clean STRUCTURED solution of what's in the picture
      let textPart;
      const snipPages = Array.from(new Set(imgs.map((im) => im.page).filter(Boolean)));
      if (isImageAsk && snipPages.length && imgs.every((im) => im.page)) {
        // every image is a region snipped from a slide (Alt+drag) → ground the
        // answer in the source slide's text AND pixels, and allow its citation
        citationSlides = snipPages.map((p) => slideByPage(p)).filter(Boolean);
        const ctx = citationSlides.map((s) =>
          "[Folie " + s.page + " | " + (s.lecture || "") + " | " + (s.title || "") + "]\n" +
          String(s.text || "").slice(0, 1000)).join("\n\n");
        textPart = (q ? q + "\n\n" : "Erkläre präzise und so knapp wie möglich, was der markierte Ausschnitt zeigt und bedeutet.\n\n") +
          "Der Ausschnitt stammt von Folie " + snipPages.join(", ") + "." +
          (ctx ? "\n\n--- Text der Quell-Folie(n) (Kontext) ---\n" + ctx : "") +
          filesText + schemaBlock +
          "\n\nSchließe mit \"(Folie " + snipPages.join(", Folie ") + ")\".";
      } else if (isImageAsk) {
        textPart = (q ? q + "\n\n" : "") +
          "Im Bild steht die gesamte Aufgabe. Lies sie vollständig (auch Tabellen und Diagramme) und gib NUR die Lösung — " +
          "direkt, alle Teilaufgaben, so knapp wie möglich zum schnellen Ablesen. " +
          "Wähle selbst das übersichtlichste Format passend zur Aufgabe (Markdown wird angezeigt: Stichpunkte, nummerierte Zeilen, Tabellen, ```sql-Blöcke …). " +
          "Kein Erklärtext (außer die Aufgabe verlangt ihn), kein Wiederholen der Aufgabe, keine Folien-Zitate." +
          filesText + schemaBlock;
      } else {
        // with a file but no typed question, ask the model to solve/explain it
        const ask = q || (files.length
          ? "Beantworte die Aufgabe aus der/den angehängten Datei(en). Enthält sie keine Frage, erkläre kurz und präzise, was der SQL-Code tut."
          : "");
        textPart = ask + filesText +
          (slidesText ? "\n\n--- Relevante Folien (Kontext) ---\n" + slidesText : "") +
          schemaBlock +
          (visionImages.length ? "\n\n(Die wichtigsten Folien folgen als Bilder, jeweils mit ihrer Foliennummer beschriftet — nutze sie für Diagramme, ER-Modelle und Tabellen.)" : "");
      }

      // neutral content blocks: text, then images — each image preceded by a short
      // label so the model knows which Folie (or screenshot) it is looking at and
      // its citations stay precise
      const blocks = [{ type: "text", text: textPart }];
      if (isImageAsk) {
        imgs.forEach((im, i) => {
          if (im.page) blocks.push({ type: "text", text: "Ausschnitt von Folie " + im.page + ":" });
          else if (imgs.length > 1) blocks.push({ type: "text", text: "Screenshot " + (i + 1) + ":" });
          blocks.push({ type: "image", media_type: im.media_type, data: im.data });
        });
      } else {
        for (const im of visionImages) {
          blocks.push({ type: "text", text: "Bild von Folie " + im.page + ":" });
          blocks.push({ type: "image", media_type: im.media_type, data: im.data });
        }
      }

      // ONE-SHOT mode: there is no conversation. Every question stands alone —
      // no prior Q/A pairs are sent to the model, and asking wipes the previous
      // exchange from the panel and from memory (a late Gegenprüfung verdict for
      // a wiped answer is dropped silently by elForTurn).
      const shownQ = q || (files.length ? files.map((f) => "📄 " + f.name).join(", ") : "");
      aiThread = [];
      aiThread.push({ role: "user", content: textPart, q: shownQ, images: imgs.map((im) => im.dataUrl) });
      aiThread.push({ role: "assistant", content: "" });
      qInput.value = ""; clearBtn.hidden = true;
      pendingImages = []; pendingFiles = []; renderAttachments();
      openChat();
      renderThread();

      // payload: exactly one user turn (text + any images) — never any history
      const messages = [{ role: "user", content: blocks }];

      // Gegenprüfung: fire the independent shadow solve NOW, in parallel with the
      // visible answer — its result is ready the moment the answer finishes, so
      // the ✓✓/⚠ verdict lands seconds after the last token instead of a full
      // second solve later
      const wantCheck = checkMode && !fastMode;
      const shadowPromise = wantCheck ? postQ(messages).then(readAll).catch(() => null) : null;

      assistantTurn = aiThread[aiThread.length - 1];
      let acc = "", pending = false;
      const flush = () => {
        pending = false;
        if (!streamBodyEl) return;
        streamBodyEl.innerHTML = renderMarkdown(acc) + '<span class="nt-caret"></span>';
        enhanceAnswer(streamBodyEl);
        const doc = aiPanel.querySelector("#ntDoc");
        if (doc) doc.scrollTop = doc.scrollHeight;
      };
      // :fast trades reasoning depth for latency (medium effort, no images, no check)
      const resp = await postQ(messages, fastMode ? "medium" : undefined); // one silent retry if nothing streamed yet
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        assistantTurn.content = acc;
        if (!pending) { pending = true; requestAnimationFrame(flush); }
      }
      assistantTurn.content = acc || "_(keine Antwort)_";
      try {
        if (typeof SlideSearchEngine !== "undefined" && typeof SlideSearchEngine.verifyCitations === "function") {
          // pages sent as images are trusted: the model may have read content there
          // that text extraction missed (diagrams), so don't strip those citations
          assistantTurn.content = SlideSearchEngine.verifyCitations(assistantTurn.content, citationSlides, {
            trustedPages: visionImages.map((im) => im.page).concat(imgs.map((im) => im.page).filter(Boolean)),
          });
        }
      } catch (e) {}
      if (streamBodyEl) {
        streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content);
        enhanceAnswer(streamBodyEl, true); // final render → read-only SQL may auto-run now
        addAnswerActions(streamBodyEl, assistantTurn);
      }
      // Gegenprüfung: detached compare of the two independent solves (2-of-3 on conflict)
      if (wantCheck && shadowPromise && assistantTurn.content.length > 12 &&
          assistantTurn.content.indexOf("_(Fehler") === -1 &&
          assistantTurn.content.indexOf("_(keine Antwort)") === -1) {
        crossCheckAnswer(assistantTurn, blocks, streamBodyEl, shadowPromise);
      }
    } catch (e) {
      if (assistantTurn) {
        assistantTurn.content = "_(Fehler: " + ((e && e.message) || "Anfrage fehlgeschlagen") + ")_";
        if (streamBodyEl) streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content);
      } else {
        showAiToast("Fehler");
      }
    } finally {
      setAiBusy(false);
      persistThread();
      const doc = aiPanel.querySelector("#ntDoc");
      if (doc) doc.scrollTop = doc.scrollHeight;
      if (askQueue.length) { // fire the next queued exam question automatically
        const nxt = askQueue.shift();
        qInput.value = nxt.q || "";
        pendingImages = nxt.imgs;
        pendingFiles = nxt.files;
        renderAttachments();
        setTimeout(runAsk, 60);
      }
    }
  }

  function ensurePanelShell() {
    if (!aiPanel.querySelector(".nt-head")) {
      aiPanel.innerHTML = '<div class="nt-head"><span class="nt-title">Notizen</span><button class="ai-close" title="Schließen (Esc)" aria-label="Schließen">&times;</button></div><div class="nt-doc" id="ntDoc"></div>';
      const c = aiPanel.querySelector(".ai-close");
      if (c) c.addEventListener("click", closeChat);
    }
  }
  function renderThread() {
    ensurePanelShell();
    const doc = aiPanel.querySelector("#ntDoc");
    doc.innerHTML = "";
    streamBodyEl = null;
    aiThread.forEach((turn) => {
      if (turn.role === "user") {
        const h = document.createElement("div");
        h.className = "nt-q";
        h.textContent = turn.q || "";
        if (turn.images && turn.images.length) {
          const wrap = document.createElement("div");
          wrap.className = "nt-qimgs";
          turn.images.forEach((src) => { const im = document.createElement("img"); im.className = "nt-qimg"; im.src = src; wrap.appendChild(im); });
          h.appendChild(wrap);
        }
        doc.appendChild(h);
      } else {
        const a = document.createElement("div");
        a.className = "nt-a";
        a.innerHTML = turn.content ? renderMarkdown(turn.content) : '<span class="nt-caret"></span>';
        enhanceAnswer(a);
        doc.appendChild(a);
        if (turn.check) ensureCheckChip(a, turn, turn.check); // restore ✓✓/⚠ verdicts
        streamBodyEl = a;
      }
    });
    const lastTurn = aiThread[aiThread.length - 1];
    if (streamBodyEl && lastTurn && lastTurn.role === "assistant" && lastTurn.content) {
      addAnswerActions(streamBodyEl, lastTurn); // re-opened thread keeps the check/copy bar
    }
    doc.scrollTop = doc.scrollHeight;
  }

  // Action bar under the newest answer: one-click self-verification (the tutor
  // re-checks its own result via the thread memory) and copy-whole-answer.
  function addAnswerActions(el, turn) {
    if (!el || el.querySelector(".nt-actions")) return;
    const bar = document.createElement("div");
    bar.className = "nt-runbar nt-actions";
    const chk = document.createElement("button");
    chk.className = "nt-run";
    chk.textContent = "⟳ Prüfen";
    chk.title = "Antwort nochmals kritisch prüfen lassen";
    chk.addEventListener("click", () => {
      if (aiStreaming) return;
      qInput.value = "Prüfe deine letzte Antwort kritisch Schritt für Schritt (Rechenwege, jede MC-Option einzeln, SQL gegen das Schema). " +
        "Wenn alles stimmt: bestätige nur das Endergebnis in einer Zeile. Wenn nicht: gib die korrigierte Antwort.";
      runAsk();
    });
    const cp = document.createElement("button");
    cp.className = "nt-run nt-copy";
    cp.textContent = "⧉ Antwort";
    cp.title = "Ganze Antwort kopieren";
    cp.addEventListener("click", () => copyToClipboard((turn && turn.content) || el.innerText, cp, "⧉ Antwort"));
    bar.appendChild(chk); bar.appendChild(cp);
    el.appendChild(bar);
  }

  // Lightweight SQL syntax coloring for rendered ```sql blocks (display only —
  // the Run/Copy buttons still read the raw textContent). Tokenize → escape →
  // wrap, so no model output ever reaches the DOM unescaped.
  const SQL_KW = new Set((
    "select from where group by having order limit offset join inner left right outer full cross natural on using as " +
    "distinct union all any and or not in is null like between exists case when then else end " +
    "insert into values update set delete truncate create table view index drop alter add column " +
    "primary key foreign references constraint unique check default auto_increment asc desc " +
    "count sum avg min max if ifnull nullif coalesce concat substring trim upper lower length round floor ceil abs mod " +
    "now curdate curtime year month day date datetime timestamp interval " +
    "varchar char int integer smallint bigint decimal numeric float double real text blob boolean bool enum " +
    "commit rollback begin start transaction savepoint release grant revoke show describe explain use database schema " +
    "with recursive over partition row_number rank dense_rank"
  ).split(" "));
  function highlightSql(src) {
    const RE = /(\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*)|('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
    let out = "", last = 0, m;
    while ((m = RE.exec(src)) !== null) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="sq-c">' + esc(m[1]) + "</span>";
      else if (m[2]) out += '<span class="sq-s">' + esc(m[2]) + "</span>";
      else if (m[3]) out += '<span class="sq-n">' + esc(m[3]) + "</span>";
      else out += SQL_KW.has(m[4].toLowerCase()) ? '<span class="sq-k">' + esc(m[4]) + "</span>" : esc(m[4]);
      last = RE.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function codeBlockHtml(buf, lang) {
    const lc = String(lang || "").toLowerCase();
    const cls = "nt-code" + (lc ? " lang-" + esc(lc) : "");
    const raw = buf.join("\n");
    const body = (lc === "sql" || lc === "mysql" || lc === "sqlite") ? highlightSql(raw) : esc(raw);
    return '<pre class="' + cls + '"><code>' + body + "</code></pre>";
  }

  // minimal, safe Markdown -> HTML (escapes everything; tolerant of partial input)
  function renderMarkdown(src) {
    if (!src) return "";
    const SLIDE_REF_RE = /\b(Folien?|Slides?|S\.?)\s*(\d+(?:\s*(?:[,;/&]|und|and)\s*(?:(?:Folien?|Slides?|S\.?)\s*)?\d+)*)/g;
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    let html = "", listType = null, inCode = false, codeBuf = [], para = [], codeLang = "";
    function inline(t) {
      t = esc(t);
      t = t.replace(SLIDE_REF_RE, function (m, kw, nums) {
        return kw + " " + nums.replace(/\d+/g, function (n) { return '<a class="nt-ref" data-page="' + n + '">' + n + "</a>"; });
      });
      return t
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        // italic: only a tightly-flanked *…* span (content starts/ends non-space,
        // opener after start/space/'(', closer before space/punct/end). This keeps
        // bare asterisks literal — cardinalities (0..*, 1..*), SELECT *, a * b.
        .replace(/(^|[\s(])\*(\S|\S[^*\n]*?\S)\*(?=[\s).,!?:;'"]|$)/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    }
    const flushPara = () => { if (para.length) { html += "<p>" + para.map(inline).join(" ") + "</p>"; para = []; } };
    const closeList = () => { if (listType) { html += "</" + listType + ">"; listType = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        if (!inCode) { flushPara(); closeList(); inCode = true; codeBuf = []; codeLang = (line.match(/^```\s*([A-Za-z0-9_+-]+)/) || [])[1] || ""; }
        else { html += codeBlockHtml(codeBuf, codeLang); inCode = false; codeLang = ""; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
      // markdown table: header row, then a |---|---| separator, then body rows
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1])) {
        flushPara(); closeList();
        const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        let tbl = '<table class="nt-table"><thead><tr>' + splitRow(line).map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && lines[i].indexOf("|") >= 0 && /\S/.test(lines[i])) {
          tbl += "<tr>" + splitRow(lines[i]).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
          i++;
        }
        i--;
        html += tbl + "</tbody></table>";
        continue;
      }
      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) { flushPara(); closeList(); html += "<hr>"; continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); closeList(); const lvl = Math.min(m[1].length + 3, 6); html += "<h" + lvl + ">" + inline(m[2]) + "</h" + lvl + ">"; continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (listType !== "ul") { closeList(); listType = "ul"; html += "<ul>"; } html += "<li>" + inline(m[1]) + "</li>"; continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (listType !== "ol") { closeList(); listType = "ol"; html += "<ol>"; } html += "<li>" + inline(m[1]) + "</li>"; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); html += "<blockquote>" + inline(m[1]) + "</blockquote>"; continue; }
      closeList();
      para.push(line);
    }
    if (inCode) html += codeBlockHtml(codeBuf, codeLang); // unterminated fence while streaming — colored + classed live
    flushPara(); closeList();
    return html;
  }
  // Hovering a "(Folie N)" citation shows a floating live preview of that slide
  // (from the cached thumbnail render); clicking jumps and pulses the matches.
  let refPrevEl = null, refPrevTimer = null, refPrevToken = 0;
  function hideRefPreview() {
    clearTimeout(refPrevTimer);
    refPrevToken++;
    if (refPrevEl) refPrevEl.classList.remove("show");
  }
  function showRefPreview(link, page) {
    clearTimeout(refPrevTimer);
    refPrevTimer = setTimeout(async () => {
      const tok = ++refPrevToken;
      if (!refPrevEl) {
        refPrevEl = document.createElement("div");
        refPrevEl.className = "ref-preview";
        refPrevEl.innerHTML = '<canvas></canvas><div class="rp-cap"></div>';
        document.body.appendChild(refPrevEl);
        document.addEventListener("scroll", hideRefPreview, true); // any scroll → hide (position would go stale)
      }
      let r;
      try { r = await getPageRender(page); } catch (e) { return; }
      if (tok !== refPrevToken || !document.body.contains(link)) return;
      const c = refPrevEl.querySelector("canvas");
      const W = 300, scale = W / r.bitmap.width;
      c.width = W; c.height = Math.round(r.bitmap.height * scale);
      c.style.width = W + "px"; c.style.height = c.height + "px";
      c.getContext("2d").drawImage(r.bitmap, 0, 0, c.width, c.height);
      const L = pageToLecture[page];
      refPrevEl.querySelector(".rp-cap").textContent = "Folie " + page + (L ? " · " + lectureShort(L) : "");
      const lr = link.getBoundingClientRect();
      const pw = W + 14, ph = c.height + 36;
      const left = Math.min(Math.max(8, lr.left - 30), window.innerWidth - pw - 8);
      let top = lr.top - ph - 8;
      if (top < 8) top = Math.min(lr.bottom + 8, window.innerHeight - ph - 8);
      refPrevEl.style.left = left + "px";
      refPrevEl.style.top = top + "px";
      refPrevEl.classList.add("show");
    }, 130);
  }
  function wireSlideRefs(container) {
    container.querySelectorAll(".nt-ref").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        hideRefPreview();
        pulsePage = +a.dataset.page;
        goToPage(+a.dataset.page);
      });
      a.addEventListener("mouseenter", () => showRefPreview(a, +a.dataset.page));
      a.addEventListener("mouseleave", hideRefPreview);
    });
  }
  // Auto-run the tutor's SQL when it is provably read-only and an exam DB is
  // loaded — the result table appears under the answer without any click.
  // Writes NEVER auto-run (WITH … DELETE included); :auto toggles the feature.
  const READONLY_SQL = /^(select|with|show|describe|desc|explain)\b/i;
  const WRITE_SQL = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|attach|pragma|set)\b/i;
  async function maybeAutoRunSql(bar, sql, btn) {
    try {
      if (!autoRunSql || !window.SqlSandbox || !SqlSandbox.schemaText) return;
      const schema = await SqlSandbox.schemaText();
      if (!schema) return; // no imported DB → nothing to run against, no error spam
      const stmts = window.SqlUtil && SqlUtil.splitStatements ? SqlUtil.splitStatements(sql) : [sql.trim()];
      if (!stmts.length || stmts.length > 2) return;
      if (!stmts.every((s) => READONLY_SQL.test(s.trim()) && !WRITE_SQL.test(s))) return;
      SqlSandbox.runInline(bar, sql, btn);
    } catch (e) {}
  }
  // Add a "Run" button under each SQL code block the tutor writes, executing it
  // in the sandbox against the imported exam DB and showing the result inline.
  // With autorun (final render of an answer), read-only queries execute themselves.
  function wireSqlRuns(container, autorun) {
    let autoRuns = 0;
    container.querySelectorAll("pre.lang-sql, pre.lang-mysql").forEach((pre) => {
      if (pre.dataset.wired) return;
      const code = pre.querySelector("code");
      if (!code) return;
      pre.dataset.wired = "1";
      const bar = document.createElement("div");
      bar.className = "nt-runbar";
      const btn = document.createElement("button");
      btn.className = "nt-run";
      btn.textContent = "▷ Ausführen";
      btn.title = "SQL gegen die importierte Datenbank ausführen";
      btn.addEventListener("click", () => { if (window.SqlSandbox) window.SqlSandbox.runInline(bar, code.textContent, btn); });
      bar.appendChild(btn);
      const copyBtn = document.createElement("button");
      copyBtn.className = "nt-run nt-copy";
      copyBtn.textContent = "⧉ Kopieren";
      copyBtn.title = "SQL in die Zwischenablage kopieren";
      copyBtn.addEventListener("click", () => copyToClipboard(code.textContent, copyBtn, "⧉ Kopieren"));
      bar.appendChild(copyBtn);
      pre.parentNode.insertBefore(bar, pre.nextSibling);
      if (autorun && autoRuns < 3) { autoRuns++; maybeAutoRunSql(bar, code.textContent, btn); }
    });
  }
  // copy text to the clipboard with a graceful fallback; flashes "✓ Kopiert" on the button
  function copyToClipboard(text, btn, label) {
    const ok = () => { if (btn) { btn.textContent = "✓ Kopiert"; setTimeout(() => { btn.textContent = label; }, 1200); } };
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); ok();
      } catch (e) {}
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(text)).then(ok, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }
  function enhanceAnswer(el, autorun) { if (!el) return; wireSlideRefs(el); wireSqlRuns(el, autorun); }

  // ---- stealth: typed commands in the search box (start with ":") ----------
  function handleSecretCommand(v) {
    const raw = v.slice(1).toLowerCase().trim();
    const done = () => { qInput.value = ""; onInput(); };
    if (raw === "ai") { toggleAiBar(); done(); }
    else if (raw === "new" || raw === "reset") { aiThread = []; persistThread(); closeChat(); showAiToast("Neue Notiz"); done(); }
    else if (raw === "close") { closeChat(); done(); }
    else if (raw === "notes" || raw === "notizen" || raw === "log") {
      if (aiThread.length) { openChat(); renderThread(); } else showAiToast("Noch keine Notizen");
      done();
    }
    else if (raw === "sql" || raw === "db" || raw === "query") { if (window.SqlSandbox) window.SqlSandbox.toggle(); done(); }
    else if (raw === "fast" || raw === "quick") { setFastMode(true); done(); }
    else if (raw === "vision" || raw === "slides" || raw === "bilder") { setFastMode(false); done(); }
    else if (raw === "auto" || raw === "autorun") {
      autoRunSql = !autoRunSql;
      try { localStorage.setItem("aiAutoRun", autoRunSql ? "1" : "0"); } catch (e) {}
      showAiToast(autoRunSql ? "SQL-Autorun an" : "SQL-Autorun aus");
      done();
    }
    else if (raw === "check" || raw === "pruefen" || raw === "prüfen") {
      checkMode = !checkMode;
      try { localStorage.setItem("aiCheck", checkMode ? "1" : "0"); } catch (e) {}
      showAiToast(checkMode ? "Gegenprüfung an (✓✓)" : "Gegenprüfung aus");
      done();
    }
    else { showAiToast(":ai  :new  :notes  :sql  :fast  :vision  :auto  :check"); done(); }
  }
  function setFastMode(on) {
    fastMode = !!on;
    try { localStorage.setItem("aiFast", fastMode ? "1" : "0"); } catch (e) {}
    showAiToast(fastMode ? "schnell · nur Text" : "Folienbilder an (Vision)");
  }
  function toggleAiBar() {
    aiBar.hidden = !aiBar.hidden;
    try { localStorage.setItem("aiBarVisible", aiBar.hidden ? "0" : "1"); } catch (e) {}
    showAiToast(aiBar.hidden ? "controls hidden" : "controls shown");
  }
  let aiToastTimer = null;
  function showAiToast(text) {
    let el = document.getElementById("aiToast");
    if (!el) { el = document.createElement("div"); el.id = "aiToast"; el.className = "ai-toast"; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(aiToastTimer);
    aiToastTimer = setTimeout(() => { if (el) el.classList.remove("show"); }, 1400);
  }

  // ===================== events =====================
  function wireEvents() {
    // Ask chords: Ctrl+Alt+Enter (or Cmd+Alt+Enter; AltGr+Enter also matches on
    // German keyboards) asks the tutor, and so does holding "d" while pressing
    // Enter — a deliberately unremarkable gesture. Plain Ctrl+Enter no longer
    // asks (the sandbox keeps it for Run). Holding "d" in the search box
    // auto-repeats "ddd…" into it, so the hold records where it started and the
    // chord removes exactly those characters before sending.
    let dHeld = false, dHoldPos = -1;
    const askChord = (e) => ((e.ctrlKey || e.metaKey) && e.altKey) || dHeld;
    const resetDHold = () => { dHeld = false; dHoldPos = -1; };
    document.addEventListener("keydown", (e) => {
      if (e.repeat || (e.key !== "d" && e.key !== "D") || e.ctrlKey || e.metaKey || e.altKey) return;
      dHeld = true;
      dHoldPos = document.activeElement === qInput ? (qInput.selectionStart == null ? qInput.value.length : qInput.selectionStart) : -1;
    });
    document.addEventListener("keyup", (e) => { if (e.key === "d" || e.key === "D") resetDHold(); });
    window.addEventListener("blur", resetDHold);
    function stripHeldD() {
      if (!dHeld || dHoldPos < 0) return;
      const pos = qInput.selectionStart == null ? qInput.value.length : qInput.selectionStart;
      if (pos > dHoldPos) qInput.value = qInput.value.slice(0, dHoldPos) + qInput.value.slice(pos);
    }

    qInput.addEventListener("input", onInput);
    qInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        panicHide(); // one press → notes gone, normal UI back (typed text stays)
      } else if (e.key === "Enter") {
        const v = qInput.value.trim();
        if (v.charAt(0) === ":") { e.preventDefault(); handleSecretCommand(v); return; } // :ai, :new, :sql, :fast, :vision
        if (askChord(e)) { e.preventDefault(); stripHeldD(); runAsk(); return; } // ONLY Ctrl+Alt+Enter / d+Enter ask — plain Enter never does, attachments included
        const f = resultsEl.querySelector(".pg-thumb"); if (f) f.click();
      }
    });
    clearBtn.addEventListener("click", () => { qInput.value = ""; onInput(); qInput.focus(); });
    askAiBtn.addEventListener("click", runAsk);
    // PASTE = ATTACH/SEARCH, never ask. Pasting anywhere in the app:
    //   · text                        → lands in the search box (live search)
    //   · screenshots / .sql files    → attach as context chips
    // Asking happens ONLY via the chords (Ctrl+Alt+Enter / d+Enter) or the
    // Ask button — there is no paste-to-ask anymore. The SQL editor keeps
    // its own paste.
    qInput.addEventListener("paste", handlePaste);
    document.addEventListener("paste", (e) => {
      const t = e.target;
      if (t === qInput) return;                                           // qInput registers its own handler
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return; // e.g. the sandbox SQL editor
      handlePaste(e);
    });
    examplesEl.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => { qInput.value = chip.textContent; clearBtn.hidden = false; runSearch(); qInput.focus(); });
    });

    prevBtn.addEventListener("click", () => goToPage(pageNum - 1));
    nextBtn.addEventListener("click", () => goToPage(pageNum + 1));
    pageInput.addEventListener("change", () => goToPage(parseInt(pageInput.value, 10) || 1));
    pageInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goToPage(parseInt(pageInput.value, 10) || 1); });
    lectureSelect.addEventListener("change", () => { const v = parseInt(lectureSelect.value, 10); if (v) goToPage(v); });

    const centerZoom = (f) => { const r = canvasScroll.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); };
    zoomInBtn.addEventListener("click", () => centerZoom(1.2));
    zoomOutBtn.addEventListener("click", () => centerZoom(1 / 1.2));
    fitBtn.addEventListener("click", () => { manualZoom = false; renderMain(pageNum); });
    // Ctrl+wheel (and trackpad pinch) zooms the slide, anchored at the cursor
    canvasScroll.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });
    wireSnip();
    const snipBtn = $("snipBtn");
    if (snipBtn) snipBtn.addEventListener("click", () => setSnipArm(!snipArm));
    const sqlBtn = $("sqlBtn");
    if (sqlBtn) sqlBtn.addEventListener("click", () => { if (window.SqlSandbox) window.SqlSandbox.toggle(); });
    // sandbox → tutor bridge: a failed query offers one-click auto-correction;
    // the corrected answer streams into the notes (and auto-runs if read-only)
    document.addEventListener("sqlfix", (e) => {
      const d = (e && e.detail) || {};
      if (!d.sql || aiStreaming) return;
      qInput.value = "Diese SQL schlägt auf der importierten Datenbank fehl — korrigiere sie. Gib NUR die korrigierte, lauffähige Abfrage.\n```sql\n" +
        d.sql + "\n```\nFehlermeldung: " + (d.error || "");
      runAsk();
    });
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!manualZoom && curMainPage) renderMain(pageNum); }, 160);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && snipArm) { e.preventDefault(); setSnipArm(false); return; }
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
      // the sandbox editor handles its own Esc (closes the drawer); everywhere
      // else Esc closes just the notes and restores the normal UI
      if (e.key === "Escape" && !typing) { e.preventDefault(); panicHide(); return; }
      if (e.key === "/" && !typing) { e.preventDefault(); revealSearch(true); } // reveal search
      else if (!typing && e.key === "Enter" && askChord(e)) { e.preventDefault(); runAsk(); } // the ask chords work from the viewer too
      else if (!typing && e.key === "ArrowLeft") { e.preventDefault(); goToPage(pageNum - 1); }
      else if (!typing && e.key === "ArrowRight") { e.preventDefault(); goToPage(pageNum + 1); }
    });
  }

  // ===================== error states =====================
  function showViewerError(title, msg) {
    loadingEl.hidden = true;
    pageWrap.hidden = true;
    viewerError.hidden = false;
    viewerError.innerHTML = "<h3>" + esc(title) + "</h3><p>" + msg + "</p>";
  }
  function showFileProtocolHelp() {
    loadingEl.hidden = true;
    viewerError.hidden = false;
    viewerError.innerHTML =
      "<h3>Start the local server first</h3><p>Run <code>start.bat</code> in the project folder, then open <code>http://localhost:8000</code>.</p>";
    resultsEl.innerHTML = stateMsg("🌐", "Server required", "Open via <code>http://localhost:8000</code>, not by double-clicking the file.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
