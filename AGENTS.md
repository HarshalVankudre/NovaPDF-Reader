# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

An offline, in-browser study tool over 317 lecture slides of a German university database course (DSCB140, lectures VL1–VL7). It combines live-as-you-type relevance search, a pdf.js slide viewer, and a hidden streaming LLM "tutor" that does RAG over the slides. No frontend build step and no framework — `index.html` loads plain `<script>` files directly.

## Commands

```
node serve.js              # run the app → http://localhost:8000 (or double-click start.bat)
node tests/engine.test.js  # the only test suite: search-engine ranking checks + latency benchmark
python build_index.py      # rebuild data/slides.json from the source PDFs (needs PyMuPDF or pypdf)
npm install                # installs the sole dependency, @anthropic-ai/sdk
```

- Must be served over **http** — opening `index.html` via `file://` is blocked by the browser and shows a help screen instead.
- `npm test` is **not** wired up (it just errors). Use `node tests/engine.test.js`. It checks ranked results against ground-truth page ranges and **exits non-zero if any ranking check fails**, so it doubles as the regression gate when changing the engine.
- After editing client-side JS, **hard-refresh with Ctrl+Shift+R** — browsers cache the plain script files aggressively.
- **Never** serve this with Python's `http.server`: it drops/empties large files on Windows and breaks PDF loading. Use the bundled `serve.js`.

## API keys

LLM keys live only in the Node server, never in the browser. Text questions use `OPENROUTER_API_KEY` (with `OPEN_ROUTER_API_KEY` accepted for compatibility); pasted-image questions use `ANTHROPIC_API_KEY`. The server loads process environment variables first, then `.env` / `.env.txt`, then `serve.config.json` (gitignored; copy from `serve.config.example.json`). **Restart the server after changing keys** — config is read once at startup.

## Architecture

Three independent layers, tied together by one invariant: the **global page number** (1–317) is the universal key. It is identical across `data/slides.json`, the merged viewer PDF, the per-lecture PDFs, and the `(Folie N)` citations the LLM emits — so a search hit, a viewer page, and a cited slide all refer to the same number.

**1. Server — `serve.js`** (Node `http`, no framework). Two jobs:
   - Static file server with HTTP range support (needed to stream the large PDFs).
   - LLM proxy so keys stay server-side. Custom routes:
     - `GET /lec/<n>` — streams `assets/lectures/vl<n>.pdf` as `text/plain; charset=x-user-defined`. Serving it as text rather than `application/pdf` is a deliberate disguise so download managers don't intercept it. This is the **only** way lecture PDFs are exposed (no direct `.pdf` URL); the browser fetches the raw bytes and hands them to pdf.js.
     - `POST /q` — streaming tutor chat (token-by-token).
     - `POST /llm` — single-shot JSON answer (legacy).

**2. Search engine — `assets/search-engine.js`** — dependency-free Okapi BM25 over an inverted index, plus a German-DB intelligence layer (diacritic folding, prefix expansion for the as-you-type feel, light stemming, bounded-edit fuzzy fallback, a bilingual synonym map, and title/coverage/proximity boosts). UMD module: the same file runs in the browser (`window.SlideSearchEngine`) and under Node (for the test). A full ranked query over 317 slides is sub-millisecond. Tune relevance via `SYN_GROUPS` (synonym/concept bridges) and the BM25 constructor options (`k1`, `b`, `titleBoost`, `coverageWeight`, `proximityWeight`) near the top of the file.

**3. UI controller — `assets/app.js`** — wires everything: debounced live search, the pdf.js canvas viewer (rendered from the in-memory `/lec` bytes, cached per lecture), the lazy thumbnail result panel (IntersectionObserver), and the hidden tutor chat. Text questions send the top BM25 slides as text to GLM 5.2. A pasted screenshot is treated as a self-contained question and routed to Haiku 4.5 with no slide context attached.

**Data pipeline — `build_index.py`** (offline, run by hand). Reads the 7 source `DSCB140 - VL*.pdf` files **from the parent directory** (`..\`, i.e. `...\Vorlesung`) — those source PDFs are **not in this repo**; only the split `assets/lectures/vl*.pdf` and the merged `assets/slides.pdf` are. It extracts per-page text plus a guessed title into `data/slides.json`, tagging each global page with its lecture.

## Providers — keep three places in sync

Two internal routes: `glm` uses OpenRouter model `z-ai/glm-5.2` with `provider.sort: "throughput"` for all text-only requests; `haiku` uses Anthropic model `claude-haiku-4-5` only when message content contains an image. Server-side modality enforcement prevents stale clients from overriding this split. Adding, removing, or renaming a provider means editing **all three**:
- providers and keys in `llm-config.js`
- the `<select id="aiProvider">` options in `index.html`
- `AI_PROVIDERS` in `assets/app.js` (drives the `:provider` typed commands)

Model IDs are overridable at runtime under `models` in `serve.config.json`.

## The stealth disguise is load-bearing

The app intentionally masquerades as a plain PDF viewer; this is a product requirement, not incidental styling — preserve it when changing the UI:
- The brand header and the entire search sidebar are hidden by default (`document.body.classList.add("stealth")`). `/` reveals search; `Esc` steps back toward the bare viewer.
- The chat panel is titled **"Notizen"** and carries no AI branding; the system prompts in `serve.js` explicitly forbid the model from mentioning that it's an AI or that the text is generated.
- It is driven from the keyboard: **Ctrl+Enter** asks the tutor; typed `:`-commands in the search box switch state (`:ai` toggles the visible controls, `:new` resets the thread, and `:glm` selects the text route; old provider names remain aliases for GLM).
- Endpoint names (`/q`, `/llm`, `/lec`) are deliberately neutral.

## Gotchas

- The in-viewer match-highlight overlay was **deliberately removed** (`drawMainHighlights` / `redrawMainHighlights` are intentional no-ops): pdf.js text-item boxes only approximate glyph positions and drifted badly at zoom. Don't reintroduce text-layer highlighting on the main view — search still finds and jumps to the correct slide.
- Slide images for both the viewer and the LLM vision path are produced by rendering the lecture PDF with `disableWorker: true` on the main thread (predictable, cached once per lecture), not via the pdf.js worker.
