# AGENTS.md

This file provides guidance to coding agents working in this repository. It mirrors `CLAUDE.md`.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. Before ticket work, read `docs/agents/issue-tracker.md`.

### Triage labels

Before triaging issues, read `docs/agents/triage-labels.md` for the five canonical label roles.

### Domain docs

Single-context domain docs. Before exploring code, read `docs/agents/domain.md` for glossary and ADR conventions.

## What this is

An offline, in-browser study tool over 317 lecture slides of a German university database course (DSCB140, lectures VL1–VL7). It combines live-as-you-type relevance search (with the matched words highlighted **in yellow** on the slides and thumbnails), a pdf.js slide viewer, a hidden streaming LLM "tutor" that does RAG over the slides (vision-grounded — it reads the actual slide images). No frontend build step and no framework — `index.html` loads plain `<script>` files directly.

## Commands

```
node serve.js                          # run the app → http://localhost:8000 (or double-click start.bat)
npm test                               # runs all 5 node test suites (see below); exits non-zero on any failure
node tests/engine.test.js              # just the search-engine ranking checks + latency benchmark
npm run test:e2e                       # browser e2e: Chromium -> serve.js -> SDK -> mock Anthropic API (free); E2E_LIVE=1 uses the real API
python build_index.py                  # rebuild data/slides.json from the source PDFs (needs PyMuPDF or pypdf)
npm install                            # installs the Anthropic SDK
```

- Must be served over **http** — opening `index.html` via `file://` is blocked by the browser and shows a help screen instead.
- `npm test` runs `engine` + `llm-config` + `client-provider` + `stream` + `server` suites. `tests/engine.test.js` checks ranked results against ground-truth page ranges and **exits non-zero if any ranking check fails**, so it's the regression gate when changing the engine. `tests/stream.test.js` covers the tutor stream retry / client-disconnect logic with a fake streamer (no network).
- After editing client-side JS, reload the page. Static files are served `no-cache` with an ETag, so a normal reload revalidates (304 when unchanged, the new file when edited); Ctrl+Shift+R still works if in doubt.
- `npm run test:e2e` (`tests/e2e.test.js`, not part of `npm test`) drives the real app in Chromium against a spawned `serve.js`. By default the SDK is pointed (`ANTHROPIC_BASE_URL`) at an in-process mock of the Anthropic API that records every request and streams scripted SSE, so it asserts the exact request (model, effort, thinking, fallback beta, slides/images) plus search, code copying, streaming, citation checks, the overload retry, and `:stop`/`:new` aborting upstream. `E2E_LIVE=1` runs the same flow against the real API with `ANTHROPIC_API_KEY` (about 5 paid requests at high effort) and checks outcomes instead of exact text. Needs Playwright + Chromium (`npm i -g playwright`, run with `NODE_PATH=$(npm root -g)`; `CHROMIUM_PATH` to reuse a browser).
- **Never** serve this with Python's `http.server`: it drops/empties large files on Windows and breaks PDF loading. Use the bundled `serve.js`.

## API keys & config

LLM keys live only in the Node server, never in the browser. Every question uses the Anthropic transport via `ANTHROPIC_API_KEY`. Claude Fable 5 remains the default; the hidden settings popup can select another compatible Claude model and its reasoning effort. The server loads process environment variables first, then `.env` / `.env.txt`, then `serve.config.json` (gitignored; copy from `serve.config.example.json`). Config/keys are read from `ROOT` by default, or from `SLIDEFINDER_CONFIG_DIR` if set (lets you keep secrets outside the served dir; the server tests use it to simulate a key-less environment). **Restart the server after changing keys** — config is read once at startup.


## Architecture

Three independent layers, tied together by one invariant: the **global page number** (1–317) is the universal key. It is identical across `data/slides.json`, the merged viewer PDF, the per-lecture PDFs, and the `(Folie N)` citations the LLM emits — so a search hit, a viewer page, and a cited slide all refer to the same number.

**1. Server — `serve.js`** (Node `http`, no framework). Two jobs:
   - Static file server with HTTP range support (needed to stream the large PDFs).
   - LLM proxy so keys stay server-side. Custom routes:
     - `GET /lec/<n>` — streams `assets/lectures/vl<n>.pdf` as `text/plain; charset=x-user-defined`. Serving it as text rather than `application/pdf` is a deliberate disguise so download managers don't intercept it. This is the **only** way lecture PDFs are exposed (no direct `.pdf` URL); the browser fetches the raw bytes and hands them to pdf.js.
     - `POST /q` — streaming tutor chat (token-by-token), with stall detection (see Providers).
     - `POST /llm` — single-shot JSON answer (legacy, server-default model).
     - `GET /prefs` — compatible model names, supported effort levels, and defaults; credentials are never returned.

**2. Search engine — `assets/search-engine.js`** — dependency-free Okapi BM25 over an inverted index, plus a German-DB intelligence layer (diacritic folding, prefix expansion for the as-you-type feel, light stemming, bounded-edit fuzzy fallback, a bilingual synonym map, and title/coverage/proximity/**ordered-phrase** boosts). UMD module: the same file runs in the browser (`window.SlideSearchEngine`) and under Node (for the test). A full ranked query over 317 slides is ~1 ms. Tune relevance via `SYN_GROUPS` (synonym/concept bridges) and the BM25 constructor options (`k1`, `b`, `titleBoost`, `coverageWeight`, `proximityWeight`, `phraseWeight`) near the top of the file. `_phrase()` rewards query words appearing in the typed order (a contiguous in-order run); `highlightHTML()` wraps matched words in `<mark>` for snippets. SQL keywords that are also stopwords (e.g. `BETWEEN`) are kept searchable.

**3. UI controller — `assets/app.js`** — wires debounced live search, the pdf.js viewer, thumbnails, normalized yellow highlights, and the hidden tutor notes. Text questions send the top-12 BM25 slides as text and up to four slides as 2200px images. `:fast` selects text-only medium-effort answers unless an explicit effort was saved in the settings; `:vision` restores slide images. Pasted screenshots are self-contained questions. Copied text files (including `.sql`) attach as removable context chips and are never executed. Rendered code blocks have copy controls. `:check` optionally runs independent answer verification.

**Data pipeline — `build_index.py`** (offline, run by hand). Reads the 7 source `DSCB140 - VL*.pdf` files **from the parent directory** (`..\`, i.e. `...\Vorlesung`) — those source PDFs are **not in this repo**; only the split `assets/lectures/vl*.pdf` and the merged `assets/slides.pdf` are. It extracts per-page text plus a guessed title into `data/slides.json`, tagging each global page with its lecture.

## Models and reasoning preferences — Anthropic, provider id stays `opus`

The provider id `opus` is the historical id for the Anthropic transport. Its default model is `claude-fable-5`; `models.opus` in server configuration can override that default. `providerChainForMessages()` still returns `["opus"]`, while `/q` accepts a per-request `model` selected from the server catalog.

The hidden settings popup (`:admin` / `:settings`, or Ctrl+Alt+A) is implemented in `assets/settings.js`. It reads `/prefs`, which caches the Anthropic Models API catalog for 15 minutes and exposes models supporting image input, adaptive thinking, and reasoning effort. Each model supplies its supported effort choices and output limit. Model and effort preferences are saved in this browser under `readerPreferences`; they apply from the next question. Esc closes the popup immediately and discards unsaved edits, including while the catalog is loading. There is no visible settings button.

The model is captured once per question and reused for retries and optional verification. Explicitly selected effort overrides the `:fast` preset; verification keeps its medium/xhigh effort requests, reduced to a supported level when needed. The server validates model choices before starting a generation, caps output at the model limit or 64000 tokens, and leaves its global default unchanged.

`streamWithFallback()` (in `serve.js`) walks the one-entry chain and streams via `streamAnthropic()` (the Anthropic SDK). **Adaptive thinking is enabled** (`thinking: { type: "adaptive", display: "summarized" }` with `output_config: { effort: REASONING_EFFORT }`, currently `"high"` — `low`/`medium`/`high`/`xhigh`/`max`), so the model decides how much to reason before answering; only the final answer is streamed (thinking deltas are never written out), and the visible answer stays terse per `CHAT_SYSTEM`. On Fable 5 thinking is always on (never send `{ type: "disabled" }`); the explicit `adaptive` field is kept so an Opus model set via the `models.opus` override still thinks. Fable requests additionally opt into the server-side refusal fallback (`server-side-fallback-2026-06-01` + `fallbacks: [{ model: "claude-opus-4-8" }]`) so a rare classifier decline is re-served by Opus 4.8 on the same stream. Because thinking can delay the first visible token by minutes on hard tasks, there is no first-token deadline: an attempt is aborted only when the upstream stream goes silent for `STALL_MS` (120 s). `display: "summarized"` exists for that — the summarized thinking deltas are the liveness signal (same thinking and billing as `"omitted"`; the summaries are never forwarded to the browser). While waiting, the notes pane shows an elapsed-seconds counter. (`budget_tokens` is removed — adaptive thinking + `effort` replaces it. `"high"` is the exam-day setting — quality over speed/cost for single-shot reasoning; drop to `"medium"` for snappier answers at some quality cost. Thinking counts toward `max_tokens`, so it's set to 64000 for headroom.) With one provider there is **no cross-provider outage fallback** — if the Anthropic API is unreachable, the tutor is down. A failure *before the first token* that looks transient (429/5xx/529, an SSE `overloaded_error`, a dropped connection — see `isTransientError`) is retried once after a short pause; 4xx errors, a stall, and anything after tokens were written are not. When the browser closes the `/q` response (tab closed, `:stop`, `:new`), the server aborts the upstream request so a paid generation doesn't keep running. (Earlier versions kept GLM/Gemini + a fallback chain, then Claude Opus 4.8, then Claude Sonnet 5, then Opus 4.8 again; now Claude Fable 5.)

`CHAT_SYSTEM` is written for Fable 5, which follows the system prompt closely: each rule is stated once, at normal volume, with its reason (e.g. source names must be exact; citations must be provided slides *because the app verifies them*). Keep that register when editing it — shouted MUST/NEVER rules over-apply on current models.

The server default is configured in `llm-config.js` or `models.opus` in `serve.config.json`; restart after server configuration changes. Selecting a model or effort in the popup needs no restart. The OpenAI-compatible transport is kept dormant in `serve.js` for re-adding another provider later.

## Vercel deployment

The same server runs on Vercel: `api/index.js` wraps `handleRequest` (exported from `serve.js`, which only calls `listen()` when run directly), and `vercel.json` routes **every** path through that one function — nothing is served from Vercel's static layer, so the `/lec` disguise and the `assets/lectures/*.pdf` block behave exactly as locally. `ANTHROPIC_API_KEY` is set as a Vercel environment variable; pushes to `main` auto-deploy via the Vercel↔GitHub integration.

## The stealth disguise is load-bearing

The app intentionally masquerades as a plain PDF viewer; this is a product requirement, not incidental styling — preserve it when changing the UI:
- The brand header and the entire search sidebar are hidden by default (`document.body.classList.add("stealth")`). `/` reveals search; `Esc` steps back toward the bare viewer.
- The chat panel is titled **"Notizen"** and carries no AI branding; the system prompts in `serve.js` explicitly forbid the model from mentioning that it's an AI or that the text is generated.
- It is driven from the keyboard: **Ctrl+Alt+Enter** — or holding **d** while pressing **Enter** — asks the tutor; typed `:`-commands in the search box switch state — `:ai` toggles the visible controls, `:new` resets the thread, `:stop` aborts the streaming answer (the partial text stays, marked "abgebrochen") and drops queued questions, `:fast` toggles text-only (no slide images) vs vision. `:admin` opens the hidden model/effort popup, also available with Ctrl+Alt+A; Esc dismisses it before other keyboard actions.
- Endpoint names (`/q`, `/llm`, `/lec`, `/prefs`) are deliberately neutral.

## Gotchas

- **Yellow highlighting is back, done correctly — don't revert it to a no-op.** The old overlay was removed because it computed absolute-pixel boxes from pdf.js text items that drifted at zoom. The current approach (`getWordBoxes` → `placeHighlights`) computes per-word boxes in **normalized 0..1 page coordinates** and positions them with CSS `%`, so they track the canvas exactly at any zoom or thumbnail size. It runs on both result thumbnails (`.rc-hl`) and the main viewer (`.hl-layer`). Within a text run, words are split and mapped onto the run's true rendered width via canvas `measureText`. If you change rendering, keep boxes normalized and rebuilt per render — do **not** go back to absolute pixels.
- Slide images for the viewer, the thumbnails, and the LLM vision path are produced by rendering the lecture PDF with `disableWorker: true` on the main thread (predictable, cached once per lecture), not via the pdf.js worker. The vision path re-renders the top slides at ~1200px (`renderSlideForVision`) for legibility; thumbnails use a cached 700px bitmap.

## Local quickstart

1. Start the server (`node serve.js` / `start.bat`). Set the tutor key in the environment or local config and restart after changing it.
2. **Theory (ERM etc.):** type the question (vision is on by default → the model reads the actual slide images) or paste a screenshot of the exam question. Ctrl+Alt+Enter (or hold d + Enter).
