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
  let pageToLecture = [];       // pageToLecture[p] = lecture object
  let frameLecture = null;      // lecture number currently shown in the main viewer
  let viewToken = 0;            // cancels superseded navigations
  let mainRenderTask = null;    // current pdf.js render task (cancel on nav)
  let mainScale = 0;            // current effective scale of the main viewer
  let manualZoom = false;       // user has used the zoom buttons
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
  async function renderSlideForVision(globalPage, width) {
    const L = pageToLecture[globalPage];
    const doc = await getLectureDoc(L);
    const page = await doc.getPage(globalPage - L.startPage + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = (width || 1200) / base.width;
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const url = c.toDataURL("image/jpeg", 0.82);
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
          for (const it of tc.items) {
            const str = it.str || "";
            if (!str.trim()) continue;
            const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
            const fontH = Math.hypot(tx[2], tx[3]) || 10;
            const x0 = tx[4], yTop = tx[5] - fontH;
            const runW = it.width || 0; // already in scale-1 page units
            meas.font = fontH + "px sans-serif";
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
    zoomLevel.textContent = Math.round(scale * 100) + "%";
    curMainPage = num; curMainCW = cw; curMainCH = ch;
    drawMainHighlights(num);
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
  let aiThread = [];        // [{role:'user'|'assistant', content, q}]
  let aiStreaming = false;
  let fastMode = false;     // :fast → text-only (no slide images) for a quick answer
  let streamBodyEl = null;  // the DOM node of the currently-streaming answer
  let pendingImages = [];   // pasted screenshots queued for the next ask {media_type,data,dataUrl}
  let pendingFiles = [];    // pasted text/SQL files queued for the next ask {name,text,truncated}

  function revealSearch(shouldFocus) {
    document.body.classList.remove("viewer-only");
    if (shouldFocus !== false) qInput.focus();
  }
  function hideSearch() {
    if (!aiPanel.hidden) closeChat();
    document.body.classList.add("viewer-only");
    qInput.blur();
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

  async function runAsk() {
    const q = qInput.value.trim();
    const imgs = pendingImages.slice();              // screenshots the user pasted
    const files = pendingFiles.slice();              // .sql/text files the user pasted
    if ((!q && !imgs.length && !files.length) || aiStreaming || !engine) return;
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
      let visionImages = [];     // rendered images of the top slides (vision grounding)
      if (q && !isImageAsk) {
        const res = engine.search(q, { limit: 12 });
        const pickedSlides = res.results.slice(0, 12);
        citationSlides = pickedSlides.map((r) => data.slides[r.docId]).filter(Boolean);
        slidesText = pickedSlides.map((r) =>
          "[Folie " + r.page + " | " + (r.lecture || "") + " | " + (r.title || "") + "]\n" +
          (((data.slides[r.docId] || {}).text) || "").slice(0, 700)
        ).join("\n\n");
        // Attach the top slides as IMAGES so the model can actually read diagrams /
        // ER-models / tables the extracted text misses. :fast turns this off.
        if (!fastMode && typeof pdfjsLib !== "undefined") {
          const topPages = pickedSlides.slice(0, VISION_SLIDES).map((r) => r.page);
          visionImages = (await Promise.all(topPages.map((pg) =>
            renderSlideForVision(pg, 2000).catch(() => null)))).filter(Boolean);
        }
      }

      // attached .sql/text files → a context block appended to the prompt
      let filesText = "";
      if (files.length) {
        filesText = "\n\n--- Angehängte Datei(en) (vom Nutzer eingefügt) ---\n" +
          files.map((f) => "### " + f.name + (f.truncated ? " (gekürzt)" : "") + "\n" + f.text).join("\n\n");
      }

      // text block: for an image ask, request a clean STRUCTURED solution of what's in the picture
      let textPart;
      if (isImageAsk) {
        textPart = (q ? q + "\n\n" : "") +
          "Im Bild steht die gesamte Aufgabe. Gib NUR die Lösung — direkt und so kurz wie möglich, zum schnellen Ablesen. " +
          "Keine Begründung, keine Überschriften, kein Wiederholen der Aufgabe, kein Erklärtext, keine Folien-Zitate. " +
          "Lückentext: nur die fehlenden Wörter, nummeriert. Multiple-Choice: nur die richtige(n) Option(en). " +
          "Mehrteilige Aufgaben (ERM→Relationen, SQL): nur das Ergebnis als knappe Stichpunkte bzw. ein ```sql-Block, vollständig aber ohne Erklärtext." +
          filesText;
      } else {
        let schema = "";
        try { if (window.SqlSandbox && SqlSandbox.schemaText) schema = await SqlSandbox.schemaText(); } catch (e) {}
        // with a file but no typed question, ask the model to solve/explain it
        const ask = q || (files.length
          ? "Beantworte die Aufgabe aus der/den angehängten Datei(en). Enthält sie keine Frage, erkläre kurz und präzise, was der SQL-Code tut."
          : "");
        textPart = ask + filesText +
          (slidesText ? "\n\n--- Relevante Folien (Kontext) ---\n" + slidesText : "") +
          (schema ? "\n\n--- Importiertes Datenbank-Schema (nutze GENAU diese Tabellen-/Spaltennamen für SQL) ---\n" + schema : "") +
          (visionImages.length ? "\n\n(Die wichtigsten Folien sind zusätzlich als Bilder beigefügt — nutze sie für Diagramme, ER-Modelle und Tabellen.)" : "");
      }

      // neutral content blocks: text, then images (pasted screenshots, or rendered top slides)
      const blocks = [{ type: "text", text: textPart }];
      const attachImgs = isImageAsk ? imgs : visionImages;
      for (const im of attachImgs) blocks.push({ type: "image", media_type: im.media_type, data: im.data });

      aiThread = [];            // no history — each question is standalone
      const shownQ = q || (files.length ? files.map((f) => "📄 " + f.name).join(", ") : "");
      aiThread.push({ role: "user", content: textPart, q: shownQ, images: imgs.map((im) => im.dataUrl) });
      aiThread.push({ role: "assistant", content: "" });
      qInput.value = ""; clearBtn.hidden = true;
      pendingImages = []; pendingFiles = []; renderAttachments();
      openChat();
      renderThread();

      // payload: a single fresh turn (text + any images), no prior conversation is sent
      const messages = [{ role: "user", content: blocks }];

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
      const resp = await fetch("q", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider, messages }),
      });
      if (!resp.ok || !resp.body) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || "Request failed (HTTP " + resp.status + ")");
      }
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
          assistantTurn.content = SlideSearchEngine.verifyCitations(assistantTurn.content, citationSlides);
        }
      } catch (e) {}
      if (streamBodyEl) { streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content); enhanceAnswer(streamBodyEl); }
    } catch (e) {
      if (assistantTurn) {
        assistantTurn.content = "_(Fehler: " + ((e && e.message) || "Anfrage fehlgeschlagen") + ")_";
        if (streamBodyEl) streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content);
      } else {
        showAiToast("Fehler");
      }
    } finally {
      setAiBusy(false);
      const doc = aiPanel.querySelector("#ntDoc");
      if (doc) doc.scrollTop = doc.scrollHeight;
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
        streamBodyEl = a;
      }
    });
    doc.scrollTop = doc.scrollHeight;
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
        else { const cls = "nt-code" + (codeLang ? " lang-" + esc(codeLang.toLowerCase()) : ""); html += '<pre class="' + cls + '"><code>' + esc(codeBuf.join("\n")) + "</code></pre>"; inCode = false; codeLang = ""; }
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
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); closeList(); const lvl = Math.min(m[1].length + 3, 6); html += "<h" + lvl + ">" + inline(m[2]) + "</h" + lvl + ">"; continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (listType !== "ul") { closeList(); listType = "ul"; html += "<ul>"; } html += "<li>" + inline(m[1]) + "</li>"; continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (listType !== "ol") { closeList(); listType = "ol"; html += "<ol>"; } html += "<li>" + inline(m[1]) + "</li>"; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); html += "<blockquote>" + inline(m[1]) + "</blockquote>"; continue; }
      closeList();
      para.push(line);
    }
    if (inCode) html += '<pre class="nt-code"><code>' + esc(codeBuf.join("\n")) + "</code></pre>";
    flushPara(); closeList();
    return html;
  }
  function wireSlideRefs(container) {
    container.querySelectorAll(".nt-ref").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); goToPage(+a.dataset.page); });
    });
  }
  // Add a "Run" button under each SQL code block the tutor writes, executing it
  // in the sandbox against the imported exam DB and showing the result inline.
  function wireSqlRuns(container) {
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
  function enhanceAnswer(el) { if (!el) return; wireSlideRefs(el); wireSqlRuns(el); }

  // ---- stealth: typed commands in the search box (start with ":") ----------
  function handleSecretCommand(v) {
    const raw = v.slice(1).toLowerCase().trim();
    if (raw === "ai") { toggleAiBar(); }
    else if (raw === "new" || raw === "reset") { aiThread = []; closeChat(); showAiToast("Neue Notiz"); return; }
    else if (raw === "close") { closeChat(); return; }
    else if (raw === "sql" || raw === "db" || raw === "query") { if (window.SqlSandbox) window.SqlSandbox.toggle(); qInput.value = ""; onInput(); return; }
    else if (raw === "fast" || raw === "quick") { setFastMode(true); }
    else if (raw === "vision" || raw === "slides" || raw === "bilder") { setFastMode(false); }
    else { showAiToast(":" + raw + " ?"); }
    qInput.value = ""; onInput();
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
    qInput.addEventListener("input", onInput);
    qInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (!aiPanel.hidden) { closeChat(); return; }       // close notes
        if (qInput.value) { qInput.value = ""; onInput(); return; } // clear search
        hideSearch();
      } else if (e.key === "Enter") {
        const v = qInput.value.trim();
        if (v.charAt(0) === ":") { e.preventDefault(); handleSecretCommand(v); return; } // :ai, :new, :sql, :fast, :vision
        if (e.ctrlKey || e.metaKey || pendingImages.length || pendingFiles.length) { e.preventDefault(); runAsk(); return; } // Ctrl/Cmd+Enter = ask; plain Enter asks when a screenshot/file is attached
        const f = resultsEl.querySelector(".pg-thumb"); if (f) f.click();
      }
    });
    clearBtn.addEventListener("click", () => { qInput.value = ""; onInput(); qInput.focus(); });
    askAiBtn.addEventListener("click", runAsk);
    // paste a screenshot OR a copied file (e.g. a .sql script) into the search box →
    // queue it as context for the next ask. Images become vision input; text/SQL
    // files become a context block. Plain-text pastes fall through to normal search.
    qInput.addEventListener("paste", async (e) => {
      const cd = e.clipboardData;
      if (!cd) return;
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
      if (!imgBlobs.length && !textBlobs.length) return;  // plain text paste → let it through
      e.preventDefault();
      for (const f of imgBlobs) {
        if (pendingImages.length >= 4) break;
        try { pendingImages.push(await processImageBlob(f, 2000)); } catch (err) {}
      }
      for (const f of textBlobs) {
        if (pendingFiles.length >= 4) break;
        try { pendingFiles.push(await processTextFile(f)); } catch (err) {}
      }
      renderAttachments();
    });
    examplesEl.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => { qInput.value = chip.textContent; clearBtn.hidden = false; runSearch(); qInput.focus(); });
    });

    prevBtn.addEventListener("click", () => goToPage(pageNum - 1));
    nextBtn.addEventListener("click", () => goToPage(pageNum + 1));
    pageInput.addEventListener("change", () => goToPage(parseInt(pageInput.value, 10) || 1));
    pageInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goToPage(parseInt(pageInput.value, 10) || 1); });
    lectureSelect.addEventListener("change", () => { const v = parseInt(lectureSelect.value, 10); if (v) goToPage(v); });

    zoomInBtn.addEventListener("click", () => { manualZoom = true; mainScale = (mainScale || 1) * 1.2; renderMain(pageNum); });
    zoomOutBtn.addEventListener("click", () => { manualZoom = true; mainScale = (mainScale || 1) / 1.2; renderMain(pageNum); });
    fitBtn.addEventListener("click", () => { manualZoom = false; renderMain(pageNum); });
    const sqlBtn = $("sqlBtn");
    if (sqlBtn) sqlBtn.addEventListener("click", () => { if (window.SqlSandbox) window.SqlSandbox.toggle(); });
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!manualZoom && curMainPage) renderMain(pageNum); }, 160);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !aiPanel.hidden) { closeChat(); return; }
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) { e.preventDefault(); revealSearch(true); } // reveal search
      else if (e.key === "Escape" && !typing && !document.body.classList.contains("viewer-only")) { e.preventDefault(); hideSearch(); }
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
