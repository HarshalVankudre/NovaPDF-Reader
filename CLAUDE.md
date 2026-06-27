# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An offline, in-browser study tool over 317 lecture slides of a German university database course (DSCB140, lectures VL1–VL7). It combines live-as-you-type relevance search, a pdf.js slide viewer, and an independent hidden streaming LLM "tutor". No frontend build step and no framework — `index.html` loads plain `<script>` files directly.

## Commands

```
node serve.js              # run the app → http://localhost:8000 (or double-click start.bat)
node tests/engine.test.js  # search-engine ranking checks + latency benchmark
node tests/tutor-message.test.js # hidden-chat payload regression checks
node tests/server.test.js  # static-server and mocked LLM proxy regression checks
python build_index.py      # rebuild data/slides.json from the source PDFs (needs PyMuPDF or pypdf)
npm install                # only needed to build the .exe (dev dep: pkg) — the app has no runtime dependencies
```

- Must be served over **http** — opening `index.html` via `file://` is blocked by the browser and shows a help screen instead.
- `npm test` is **not** wired up (it just errors). Run the three Node test files above directly. `engine.test.js` checks ranked results against ground-truth page ranges and **exits non-zero if any ranking check fails**, so it doubles as the regression gate when changing the engine.
- `serve.js` now sends a validator (`ETag` + `Last-Modified`) on every file. Source files (`index.html`, `app.js`, `search-engine.js`, `style.css`, `slides.json`) use `Cache-Control: no-cache`, so a **normal refresh** revalidates and picks up edits (a matching ETag returns a fast `304`); a hard-refresh is no longer required. Vendored libs (`pdf.min.js`, `pdf.worker.min.js`) and the PDFs cache hard (`max-age=2592000`) but stay revalidatable via their ETag, so a replaced file is picked up on an explicit reload. Text assets are gzipped on the wire.
- **Never** serve this with Python's `http.server`: it drops/empties large files on Windows and breaks PDF loading. Use the bundled `serve.js`.

## API keys

The LLM key lives only in the Node server, never in the browser. The tutor uses **Qwen 3.5 Flash with reasoning disabled via OpenRouter** — set `OPENROUTER_API_KEY` (environment variable) or `openrouterApiKey` in `serve.config.json` (gitignored; copy from `serve.config.example.json`). **Restart the server after changing the key** — config is read once at startup.

## Architecture

Three independent layers. The slide-data, search, and viewer paths share one invariant: the **global page number** (1–317) is identical across `data/slides.json`, the merged viewer PDF, and the per-lecture PDFs. The hidden tutor is intentionally independent and receives no automatic slide context.

**1. Server — `serve.js`** (Node `http`, no framework). Two jobs:
   - Static file server with HTTP range support (needed to stream the large PDFs), gzip for text assets, and `ETag`/`Last-Modified` conditional caching (`304`) so repeat loads don't re-download the unchanging JS/PDF. Range responses and PDFs are never gzipped (gzip and byte ranges don't mix).
   - LLM proxy so keys stay server-side. Custom routes:
     - `GET /lec/<n>` — streams `assets/lectures/vl<n>.pdf` as `text/plain; charset=x-user-defined`. Serving it as text rather than `application/pdf` is a deliberate disguise so download managers don't intercept it. This is the **only** way lecture PDFs are exposed (no direct `.pdf` URL); the browser fetches the raw bytes and hands them to pdf.js.
     - `POST /q` — streaming tutor chat (token-by-token).
     - `POST /llm` — single-shot JSON answer (legacy).

**2. Search engine — `assets/search-engine.js`** — dependency-free Okapi BM25 over an inverted index, plus a German-DB intelligence layer (diacritic folding, prefix expansion for the as-you-type feel, light stemming, bounded-edit fuzzy fallback, a bilingual synonym map, and title/coverage/proximity boosts). UMD module: the same file runs in the browser (`window.SlideSearchEngine`) and under Node (for the test). A full ranked query over 317 slides is sub-millisecond. Tune relevance via `SYN_GROUPS` (synonym/concept bridges) and the BM25 constructor options (`k1`, `b`, `titleBoost`, `coverageWeight`, `proximityWeight`) near the top of the file.

**3. UI controller — `assets/app.js`** — wires everything: debounced live search, the pdf.js canvas viewer (rendered from the in-memory `/lec` bytes, cached per lecture), the lazy thumbnail result panel (IntersectionObserver), and the hidden tutor chat. The main viewer caches rendered pages as `ImageBitmap`s keyed by `page@scale@dpr` (LRU, `MAIN_CACHE_MAX`), prefetches the next/prev page on idle so arrow-key navigation is instant, and zooms with an instant CSS-transform preview committed by a debounced crisp re-render. `assets/tutor-message.js` builds a provider-neutral tutor turn containing only the typed question plus optional pasted screenshots. BM25 results, extracted slide text, and rendered lecture slides are never attached to `/q`.

**Data pipeline — `build_index.py`** (offline, run by hand). Reads the 7 source `DSCB140 - VL*.pdf` files **from the parent directory** (`..\`, i.e. `...\Vorlesung`) — those source PDFs are **not in this repo**; only the split `assets/lectures/vl*.pdf` and the merged `assets/slides.pdf` are. It extracts per-page text plus a guessed title into `data/slides.json`, tagging each global page with its lecture.

## The AI provider

One provider only: **Qwen 3.5 Flash** (`qwen/qwen3.5-flash-02-23`) via **OpenRouter**, sent with `reasoning: { effort: "none" }`. It's a single `TUTOR` config object in `serve.js` (model overridable via `models.tutor` in `serve.config.json`; the legacy `models.grok` override is still accepted; the OpenRouter base URL is overridable via `OPENROUTER_API_URL` for a proxy or test mock). The browser sends a provider-neutral text-plus-optional-images payload; there is **no provider picker**. Qwen is multimodal, so the tutor handles ordinary text questions and pasted screenshots. `serve.js` calls OpenRouter with plain `fetch` — there are no runtime npm dependencies.

## The stealth disguise is load-bearing

The app intentionally masquerades as a plain PDF viewer; this is a product requirement, not incidental styling — preserve it when changing the UI:
- The brand header and the entire search sidebar are hidden by default (`document.body.classList.add("stealth")`). `/` reveals search; `Esc` steps back toward the bare viewer.
- The chat panel is titled **"Notizen"** and carries no AI branding; the system prompts in `serve.js` explicitly forbid the model from mentioning that it's an AI or that the text is generated.
- It is driven from the keyboard: **Ctrl+Enter** asks the tutor; typed `:`-commands in the search box switch state (`:ai` toggles the visible controls, `:new` resets the thread).
- Endpoint names (`/q`, `/llm`, `/lec`) are deliberately neutral.

## Gotchas

- The in-viewer match-highlight overlay was **deliberately removed** (`drawMainHighlights` / `redrawMainHighlights` are intentional no-ops): pdf.js text-item boxes only approximate glyph positions and drifted badly at zoom. Don't reintroduce text-layer highlighting on the main view — search still finds and jumps to the correct slide.
- Viewer slide images are produced by rendering the lecture PDF with `disableWorker: true` on the main thread (predictable, cached once per lecture), not via the pdf.js worker. The tutor does not render or attach lecture slides.
