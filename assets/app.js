/* ============ DB Slide Finder — UI controller ============
 * Real-time relevance search (SlideSearchEngine) + a pdf.js slide viewer.
 * Lecture PDFs are fetched from a disguised text/plain endpoint (so a download
 * manager can't grab them) and rendered to <canvas> from the in-memory bytes,
 * with matched search terms highlighted on both the main view and thumbnails.
 */
(function () {
  "use strict";

  const DATA_URL = "data/slides.json";

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
  // main-view render cache: instant revisit (and zoom-back) + neighbour prefetch
  const mainBitmapCache = new Map(); // "page@scale@dpr" -> {bitmap,cssW,cssH,devW,devH}
  const pageBaseW = new Map();       // globalPage -> unscaled viewport width
  const MAIN_CACHE_MAX = 10;         // keep ~10 full-res pages, LRU-evicted
  let zoomTimer = null, targetScale = 0, prefetchTimer = null;

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
        const resp = await fetch("/lec/" + L.num, { cache: "default" }); // server caches it (immutable) → instant re-open
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
  // Render a slide to a bitmap once and remember its text-item boxes for highlighting.
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
        let items = [];
        try {
          const tc = await page.getTextContent();
          items = tc.items.map((it) => {
            const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
            const fontH = Math.hypot(tx[2], tx[3]) || 10;
            return { str: it.str || "", x: tx[4], y: tx[5] - fontH, w: (it.width || 0) * scale, h: fontH * 1.14 };
          });
        } catch (e) {}
        const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(canvas) : canvas;
        return { bitmap, cssW: vp.width, cssH: vp.height, items };
      })());
    }
    return pageRenderCache.get(globalPage);
  }

  const fold = (w) => (typeof SlideSearchEngine.fold === "function" ? SlideSearchEngine.fold(w) : w.toLowerCase());
  function itemHasHit(str, cq) {
    if (!cq || !cq.hitSet || !cq.hitSet.size) return false;
    const re = /[\p{L}\p{N}]+/gu; let m;
    while ((m = re.exec(str)) !== null) if (cq.hitSet.has(fold(m[0]))) return true;
    return false;
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
    if (hl) hl.innerHTML = "";
    card.classList.add("thumb-ready");
  }

  // ---- fast main-view rendering: bitmap cache + prefetch + instant zoom -------
  const computeDpr = () => Math.min(window.devicePixelRatio || 1, 2);
  const availW = () => Math.max(canvasScroll.clientWidth - 48, 240);
  const mainKey = (page, scale, dpr) => page + "@" + scale.toFixed(4) + "@" + dpr;
  const toBitmap = (cv) => (typeof createImageBitmap === "function" ? createImageBitmap(cv) : Promise.resolve(cv));

  function putMainBitmap(key, entry) {
    const prev = mainBitmapCache.get(key);
    if (prev) {
      mainBitmapCache.delete(key); // re-insert = most-recent
      if (prev.bitmap && prev.bitmap !== entry.bitmap && typeof prev.bitmap.close === "function") { try { prev.bitmap.close(); } catch (e) {} }
    }
    mainBitmapCache.set(key, entry);
    while (mainBitmapCache.size > MAIN_CACHE_MAX) {
      const oldestKey = mainBitmapCache.keys().next().value;
      const old = mainBitmapCache.get(oldestKey);
      mainBitmapCache.delete(oldestKey);
      if (old && old.bitmap && typeof old.bitmap.close === "function") { try { old.bitmap.close(); } catch (e) {} }
    }
  }
  // Paint a cached render straight to the visible canvas — no pdf.js, instant.
  function drawMainBitmap(entry) {
    canvas.style.transform = "";
    canvas.width = entry.devW; canvas.height = entry.devH;
    canvas.style.width = entry.cssW + "px"; canvas.style.height = entry.cssH + "px";
    pageWrap.style.width = entry.cssW + "px"; pageWrap.style.height = entry.cssH + "px";
    canvas.getContext("2d").drawImage(entry.bitmap, 0, 0);
    loadingEl.hidden = true; viewerError.hidden = true; pageWrap.hidden = false;
  }
  // Render a neighbour page into the cache (off the live canvas) so the next
  // arrow-key press is instant. Idle-scheduled, one page at a time.
  async function prefetchMain(n, manual, manualScale, dpr, aw) {
    if (n < 1 || n > pdfTotal || typeof pdfjsLib === "undefined") return;
    const L = pageToLecture[n];
    if (!L) return;
    try {
      const doc = await getLectureDoc(L);
      const page = await doc.getPage(n - L.startPage + 1);
      const base = page.getViewport({ scale: 1 });
      pageBaseW.set(n, base.width);
      const scale = manual && manualScale ? manualScale : aw / base.width;
      const key = mainKey(n, scale, dpr);
      if (mainBitmapCache.has(key)) return;
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      const bitmap = await toBitmap(c);
      putMainBitmap(key, { bitmap, cssW: Math.floor(vp.width), cssH: Math.floor(vp.height), devW: c.width, devH: c.height });
    } catch (e) { /* prefetch is best-effort */ }
  }
  function schedulePrefetch(num, manual, manualScale, dpr, aw) {
    clearTimeout(prefetchTimer);
    const run = () => { prefetchMain(num + 1, manual, manualScale, dpr, aw); prefetchMain(num - 1, manual, manualScale, dpr, aw); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 600 });
    else prefetchTimer = setTimeout(run, 180);
  }
  // Instant zoom: nudge the current bitmap with a CSS transform right away, then
  // re-render crisply once the clicks settle (no main-thread render per click).
  function zoomBy(factor) {
    manualZoom = true;
    const from = mainScale || 1;
    targetScale = Math.min(Math.max((targetScale || from) * factor, 0.25), 6);
    canvas.style.transformOrigin = "top center";
    canvas.style.transform = "scale(" + (targetScale / from) + ")";
    zoomLevel.textContent = Math.round(targetScale * 100) + "%";
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => { mainScale = targetScale; targetScale = 0; renderMain(pageNum); }, 130);
  }

  async function renderMain(num) {
    const L = pageToLecture[num];
    if (!L) return;
    if (typeof pdfjsLib === "undefined") {
      showViewerError("PDF.js could not load", "Search is still available, but the slide viewer needs <code>assets/pdf.min.js</code>.");
      return;
    }
    const dpr = computeDpr();
    const aw = availW();

    // fast path: this page is already cached at the scale we'd render it → blit it
    if (pageBaseW.has(num)) {
      const fScale = manualZoom && mainScale ? mainScale : aw / pageBaseW.get(num);
      const hit = mainBitmapCache.get(mainKey(num, fScale, dpr));
      if (hit) {
        ++viewToken; // supersede any in-flight render
        if (mainRenderTask) { try { mainRenderTask.cancel(); } catch (e) {} mainRenderTask = null; }
        frameLecture = L.num; // keep the loading-gate consistent with what's on screen
        mainScale = fScale;
        putMainBitmap(mainKey(num, fScale, dpr), hit); // bump LRU recency
        drawMainBitmap(hit);
        zoomLevel.textContent = Math.round(fScale * 100) + "%";
        curMainPage = num; curMainCW = hit.cssW; curMainCH = hit.cssH;
        schedulePrefetch(num, manualZoom, mainScale, dpr, aw);
        return;
      }
    }

    // slow path: render with pdf.js, then cache the result for instant revisit
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

    const base = page.getViewport({ scale: 1 });
    pageBaseW.set(num, base.width);
    const scale = manualZoom && mainScale ? mainScale : aw / base.width;
    mainScale = scale;
    const vp = page.getViewport({ scale });
    const cw = Math.floor(vp.width), ch = Math.floor(vp.height);
    canvas.style.transform = "";
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
    drawMainHighlights(num, cw, ch);

    // cache this render — snapshot synchronously, navigation may repaint next tick
    const snap = document.createElement("canvas");
    snap.width = canvas.width; snap.height = canvas.height;
    snap.getContext("2d").drawImage(canvas, 0, 0);
    toBitmap(snap).then((bitmap) => putMainBitmap(mainKey(num, scale, dpr), { bitmap, cssW: cw, cssH: ch, devW: snap.width, devH: snap.height })).catch(() => {});
    schedulePrefetch(num, manualZoom, scale, dpr, aw);
  }

  // In-page match overlay was removed: the pdf.js text-item boxes only
  // approximate glyph positions and drifted badly at zoom (wide misplaced
  // bands). The viewer now reads as a plain PDF; search still finds + jumps
  // to the right slide. Keep the layer cleared so nothing stale lingers.
  function drawMainHighlights() {
    if (hlLayer) hlLayer.innerHTML = "";
  }
  function redrawMainHighlights() {
    if (hlLayer) hlLayer.innerHTML = "";
  }

  function goToPage(num) {
    clearTimeout(zoomTimer); targetScale = 0; // cancel a pending zoom commit — we're navigating
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
    renderPageList(res.results.map((r) => r.page), res.compiled);
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
  function renderPageList(pages, cq) {
    examplesEl.hidden = true;
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (!pages.length) { resultsEl.innerHTML = stateMsg("🔍", "Keine Treffer", "Andere Begriffe versuchen."); return; }
    if (typeof pdfjsLib !== "undefined" && "IntersectionObserver" in window) {
      thumbObserver = new IntersectionObserver((entries, obs) => {
        for (const e of entries) if (e.isIntersecting) {
          obs.unobserve(e.target);
          renderCardThumb(e.target, +e.target.dataset.page, cq);
        }
      }, { root: resultsEl, rootMargin: "700px 0px" });
    }
    const frag = document.createDocumentFragment();
    const cards = [];
    pages.forEach((p) => {
      const card = document.createElement("button");
      card.className = "pg-thumb";
      card.dataset.page = p;
      card.innerHTML = '<div class="pg-img"><canvas class="rc-canvas"></canvas><div class="rc-hl"></div></div><div class="pg-num">' + p + "</div>";
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
  let streamBodyEl = null;  // the DOM node of the currently-streaming answer
  let pendingImages = [];   // pasted screenshots queued for the next ask {media_type,data,dataUrl}

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

  // ---- images: pasted screenshots + rendered slide pictures (vision) --------
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
  // Discreet attachment strip: small thumbnails of queued pastes, each removable.
  function renderPendingImages() {
    if (!attStrip) return;
    attStrip.innerHTML = "";
    attStrip.hidden = pendingImages.length === 0;
    pendingImages.forEach((im, i) => {
      const t = document.createElement("span");
      t.className = "att-thumb";
      t.innerHTML = '<img src="' + im.dataUrl + '" alt=""><button class="att-x" title="Entfernen" aria-label="Entfernen">&times;</button>';
      t.querySelector(".att-x").addEventListener("click", () => { pendingImages.splice(i, 1); renderPendingImages(); });
      attStrip.appendChild(t);
    });
  }

  async function runAsk() {
    const q = qInput.value.trim();
    const imgs = pendingImages.slice();              // screenshots the user pasted
    if ((!q && !imgs.length) || aiStreaming) return;
    setAiBusy(true);
    let assistantTurn = null;

    try {
      const built = window.TutorMessageBuilder.buildTutorMessage(q, imgs);
      const textPart = built.text;
      const messages = built.messages;

      aiThread = [];            // no history — each question is standalone
      aiThread.push({ role: "user", content: textPart, q: q, images: imgs.map((im) => im.dataUrl) });
      aiThread.push({ role: "assistant", content: "" });
      qInput.value = ""; clearBtn.hidden = true;
      pendingImages = []; renderPendingImages();
      openChat();
      renderThread();

      assistantTurn = aiThread[aiThread.length - 1];
      let acc = "", pending = false;
      const flush = () => {
        pending = false;
        if (!streamBodyEl) return;
        streamBodyEl.innerHTML = renderMarkdown(acc) + '<span class="nt-caret"></span>';
        wireSlideRefs(streamBodyEl);
        const doc = aiPanel.querySelector("#ntDoc");
        if (doc) doc.scrollTop = doc.scrollHeight;
      };
      const resp = await fetch("q", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
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
      if (streamBodyEl) { streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content); wireSlideRefs(streamBodyEl); }
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
        wireSlideRefs(a);
        doc.appendChild(a);
        streamBodyEl = a;
      }
    });
    doc.scrollTop = doc.scrollHeight;
  }

  // minimal, safe Markdown -> HTML (escapes everything; tolerant of partial input)
  function renderMarkdown(src) {
    if (!src) return "";
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    let html = "", listType = null, inCode = false, codeBuf = [], para = [];
    function inline(t) {
      t = esc(t);
      t = t.replace(/\b(Folien?|Slides?|S\.)\s*(\d{1,3}(?:\s*(?:[,;/&]|und|and)\s*\d{1,3})*)/g, function (m, kw, nums) {
        return kw + " " + nums.replace(/\d{1,3}/g, function (n) { return '<a class="nt-ref" data-page="' + n + '">' + n + "</a>"; });
      });
      return t
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    }
    const flushPara = () => { if (para.length) { html += "<p>" + para.map(inline).join(" ") + "</p>"; para = []; } };
    const closeList = () => { if (listType) { html += "</" + listType + ">"; listType = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        if (!inCode) { flushPara(); closeList(); inCode = true; codeBuf = []; }
        else { html += '<pre class="nt-code"><code>' + esc(codeBuf.join("\n")) + "</code></pre>"; inCode = false; }
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

  // ---- stealth: typed commands in the search box (start with ":") ----------
  function handleSecretCommand(v) {
    const raw = v.slice(1).toLowerCase().trim();
    if (raw === "ai") { toggleAiBar(); }
    else if (raw === "new" || raw === "reset") { aiThread = []; closeChat(); showAiToast("Neue Notiz"); return; }
    else if (raw === "close") { closeChat(); return; }
    else { showAiToast(":" + raw + " ?"); }
    qInput.value = ""; onInput();
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
        if (v.charAt(0) === ":") { e.preventDefault(); handleSecretCommand(v); return; } // :ai, :new, :codex, :sonnet, :grok, :deepseek
        if (e.ctrlKey || e.metaKey || pendingImages.length) { e.preventDefault(); runAsk(); return; } // Ctrl/Cmd+Enter = ask; plain Enter asks when a screenshot is attached
        const f = resultsEl.querySelector(".pg-thumb"); if (f) f.click();
      }
    });
    clearBtn.addEventListener("click", () => { qInput.value = ""; onInput(); qInput.focus(); });
    askAiBtn.addEventListener("click", runAsk);
    // paste a screenshot/image into the search box → queue it for the next ask (hidden)
    qInput.addEventListener("paste", async (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) if (it.type && it.type.indexOf("image") === 0) { const f = it.getAsFile(); if (f) files.push(f); }
      if (!files.length) return;                 // plain text paste → let it through
      e.preventDefault();
      for (const f of files) {
        if (pendingImages.length >= 4) break;
        try { pendingImages.push(await processImageBlob(f, 1400)); } catch (err) {}
      }
      renderPendingImages();
    });
    examplesEl.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => { qInput.value = chip.textContent; clearBtn.hidden = false; runSearch(); qInput.focus(); });
    });

    prevBtn.addEventListener("click", () => goToPage(pageNum - 1));
    nextBtn.addEventListener("click", () => goToPage(pageNum + 1));
    pageInput.addEventListener("change", () => goToPage(parseInt(pageInput.value, 10) || 1));
    pageInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goToPage(parseInt(pageInput.value, 10) || 1); });
    lectureSelect.addEventListener("change", () => { const v = parseInt(lectureSelect.value, 10); if (v) goToPage(v); });

    zoomInBtn.addEventListener("click", () => zoomBy(1.2));
    zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.2));
    fitBtn.addEventListener("click", () => { manualZoom = false; targetScale = 0; clearTimeout(zoomTimer); canvas.style.transform = ""; renderMain(pageNum); });
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
