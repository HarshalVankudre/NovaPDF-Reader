# AGENTS.md

This file provides guidance to coding agents working in this repository. It mirrors `CLAUDE.md`.

## What this is

An offline, in-browser study tool over 317 lecture slides of a German university database course (DSCB140, lectures VL1–VL7). It combines live-as-you-type relevance search (with the matched words highlighted **in yellow** on the slides and thumbnails), a pdf.js slide viewer, a hidden streaming LLM "tutor" that does RAG over the slides (vision-grounded — it reads the actual slide images), and a **SQL sandbox** that runs queries against an imported database (local MySQL, or in-browser SQLite as a fallback). No frontend build step and no framework — `index.html` loads plain `<script>` files directly.

## Commands

```
node serve.js                          # run the app → http://localhost:8000 (or double-click start.bat)
npm test                               # runs all 5 node test suites (see below); exits non-zero on any failure
node mysql-to-sqlite.js --database DB  # snapshot a live MySQL DB → data/snapshot.sqlite (the app auto-loads it)
node tests/engine.test.js              # just the search-engine ranking checks + latency benchmark
python build_index.py                  # rebuild data/slides.json from the source PDFs (needs PyMuPDF or pypdf)
npm install                            # installs deps: mysql2 (pure-JS), sql.js (WASM)
```

- Must be served over **http** — opening `index.html` via `file://` is blocked by the browser and shows a help screen instead.
- `npm test` runs `engine` + `llm-config` + `client-provider` + `sql-util` + `server` suites. `tests/engine.test.js` checks ranked results against ground-truth page ranges and **exits non-zero if any ranking check fails**, so it's the regression gate when changing the engine. `tests/sql-util.test.js` covers the mysqldump→SQLite cleaning.
- After editing client-side JS, **hard-refresh with Ctrl+Shift+R** — browsers cache the plain script files aggressively.
- **Never** serve this with Python's `http.server`: it drops/empties large files on Windows and breaks PDF loading. Use the bundled `serve.js`.

## API keys & config

LLM keys live only in the Node server, never in the browser. Every question — text and pasted screenshots alike — goes to the single multimodal model Claude Fable 5 via `ANTHROPIC_API_KEY`. The server loads process environment variables first, then `.env` / `.env.txt`, then `serve.config.json` (gitignored; copy from `serve.config.example.json`). Config/keys are read from `ROOT` by default, or from `SLIDEFINDER_CONFIG_DIR` if set (lets you keep secrets outside the served dir; the server tests use it to simulate a key-less environment). **Restart the server after changing keys** — config is read once at startup.

For the SQL sandbox, optionally configure local MySQL under `mysql` in `serve.config.json` (or `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` env vars). If MySQL is unreachable (e.g. `root` needs a password), the browser silently falls back to in-browser SQLite.

## Architecture

Three independent layers, tied together by one invariant: the **global page number** (1–317) is the universal key. It is identical across `data/slides.json`, the merged viewer PDF, the per-lecture PDFs, and the `(Folie N)` citations the LLM emits — so a search hit, a viewer page, and a cited slide all refer to the same number.

**1. Server — `serve.js`** (Node `http`, no framework). Three jobs:
   - Static file server with HTTP range support (needed to stream the large PDFs).
   - LLM proxy so keys stay server-side. Custom routes:
     - `GET /lec/<n>` — streams `assets/lectures/vl<n>.pdf` as `text/plain; charset=x-user-defined`. Serving it as text rather than `application/pdf` is a deliberate disguise so download managers don't intercept it. This is the **only** way lecture PDFs are exposed (no direct `.pdf` URL); the browser fetches the raw bytes and hands them to pdf.js.
     - `POST /q` — streaming tutor chat (token-by-token), with a first-token timeout (see Providers).
     - `POST /llm` — single-shot JSON answer (legacy).
   - SQL bridge to a local MySQL (via pure-JS `mysql2`): `GET /sql/status`, `GET /sql/schema`, `POST /sql/query`, `POST /sql/import`, plus `GET /sql/filestatus` + `GET /sql/file` which expose the prebuilt SQLite snapshot (`data/snapshot.sqlite`). Optional — if `mysql2` is missing or MySQL is unreachable, the client uses SQLite instead.

**2. Search engine — `assets/search-engine.js`** — dependency-free Okapi BM25 over an inverted index, plus a German-DB intelligence layer (diacritic folding, prefix expansion for the as-you-type feel, light stemming, bounded-edit fuzzy fallback, a bilingual synonym map, and title/coverage/proximity/**ordered-phrase** boosts). UMD module: the same file runs in the browser (`window.SlideSearchEngine`) and under Node (for the test). A full ranked query over 317 slides is ~1 ms. Tune relevance via `SYN_GROUPS` (synonym/concept bridges) and the BM25 constructor options (`k1`, `b`, `titleBoost`, `coverageWeight`, `proximityWeight`, `phraseWeight`) near the top of the file. `_phrase()` rewards query words appearing in the typed order (a contiguous in-order run); `highlightHTML()` wraps matched words in `<mark>` for snippets. SQL keywords that are also stopwords (e.g. `BETWEEN`) are kept searchable.

**3. UI controller — `assets/app.js`** — wires everything: debounced live search, the pdf.js canvas viewer (rendered from the in-memory `/lec` bytes, cached per lecture), the result panel (rich cards with thumbnail + yellow word-highlight overlay + highlighted snippet in search mode; a plain page-navigator grid in browse mode), the **yellow match overlay** on both thumbnails and the main viewer (see Gotchas), the hidden tutor chat, and the SQL sandbox hooks. Text questions send the top-12 BM25 slides as text **plus the top-3 as rendered images** (vision grounding) and the imported DB schema if present — the model is multimodal with high-res vision, so it reads the ER diagrams/SQL directly. `:fast` disables the images for a quick text-only answer. A pasted screenshot is a self-contained question sent to the model with no slide context. A **pasted/copied `.sql` (or other text) file** is read as text and attached as a context block for the next question (shown as a removable chip in the attachment strip; `pendingFiles` in `app.js`, mirroring `pendingImages` — never executed, just sent to the tutor). Generated `​```sql` blocks get a **Run** button that executes in the sandbox.

**4. SQL sandbox — `assets/sandbox.js` + `assets/sql-util.js`** — `window.SqlSandbox` (a right-side drawer opened with `:sql`; there is no toolbar SQL button). Two engines, auto-selected: the local-MySQL bridge (dialect-exact, preferred) or in-browser SQLite via `sql.js` (vendored at `assets/sql-wasm.js` + `assets/sql-wasm.wasm`, loaded lazily and memoized via `ensureSqlite`, fully offline). The importer accepts: a **binary `.sqlite` snapshot file** (detected by magic header → loaded directly via `new SQL.Database(bytes)`, instant, exact — also importable by pasting the file anywhere in the app), a mysqldump/`.sql` script, or CSV-per-table. `assets/sql-util.js` is a pure, Node-testable UMD module that splits statements, strips `CREATE DATABASE`/`USE`, best-effort-converts a mysqldump to SQLite (`toSqlite`), and builds CSV→SQL. On open, the sandbox checks `/sql/filestatus` and **auto-loads `data/snapshot.sqlite`** if present (the fast path).

**SQL snapshot — `mysql-to-sqlite.js`** (Node CLI, run by hand). Connects to the live MySQL with given credentials and writes a single SQLite file (`data/snapshot.sqlite` by default) using `mysql2` (streaming read) + `sql.js` (build/export), one transaction per table. This is the *intended* path: snapshot once → the app auto-loads the binary file instantly (no dump-dialect cleaning, exact data). SQLite dialect still differs from MySQL for some functions; `serve.config.json`'s `mysql` block / `MYSQL_*` env vars provide default credentials so usually you only pass `--database`. Supports TLS via `--ssl` / `--ssl-ca <file>` / `--ssl-cert`/`--ssl-key` / `--ssl-insecure` (or an `ssl` object in the config `mysql` block) for remote/cloud MySQL. The file is gitignored (private data). If the source DB is itself a `.sqlite` file, skip this and load it directly; PostgreSQL would need a separate `pg`-based variant.

**Data pipeline — `build_index.py`** (offline, run by hand). Reads the 7 source `DSCB140 - VL*.pdf` files **from the parent directory** (`..\`, i.e. `...\Vorlesung`) — those source PDFs are **not in this repo**; only the split `assets/lectures/vl*.pdf` and the merged `assets/slides.pdf` are. It extracts per-page text plus a guessed title into `data/slides.json`, tagging each global page with its lecture.

## Providers — one model (Claude Fable 5), provider id stays `opus`

One model: provider id `opus` (historical name), model `claude-fable-5`, `kind: "anthropic"`, keyed by `ANTHROPIC_API_KEY`. It is multimodal with high-resolution vision, so it serves **every** request — text questions and pasted screenshots alike. `providerChainForMessages()` (in `llm-config.js`) always returns `["opus"]` and `selectProviderForMessages()` always returns `"opus"`. There is no provider dropdown, no aliases, and no `:`-command to switch models — the client hardcodes the model.

`streamWithFallback()` (in `serve.js`) walks the one-entry chain and streams via `streamAnthropic()` (the Anthropic SDK). **Adaptive thinking is enabled** (`thinking: { type: "adaptive" }` with `output_config: { effort: REASONING_EFFORT }`, currently `"high"` — `low`/`medium`/`high`/`xhigh`/`max`), so the model decides how much to reason before answering; only the final answer is streamed (thinking deltas are never written out), and the visible answer stays terse per `CHAT_SYSTEM`. On Fable 5 thinking is always on (never send `{ type: "disabled" }`); the explicit `adaptive` field is kept so an Opus model set via the `models.opus` override still thinks. Fable requests additionally opt into the server-side refusal fallback (`server-side-fallback-2026-06-01` + `fallbacks: [{ model: "claude-opus-4-8" }]`) so a rare classifier decline is re-served by Opus 4.8 on the same stream. Because thinking delays the first visible token, `FIRST_TOKEN_MS` is sized generously. (`budget_tokens` is removed — adaptive thinking + `effort` replaces it. `"high"` is the default setting — quality over speed/cost for single-shot reasoning; drop to `"medium"` for snappier answers at some quality cost. Thinking counts toward `max_tokens`, so it's set to 32000 for headroom.) With one model there is **no cross-provider outage fallback** — if the Anthropic API is unreachable, the tutor is down. (Earlier versions kept GLM/Gemini + a fallback chain, then Claude Opus 4.8, then Claude Sonnet 5, then Opus 4.8 again; now Claude Fable 5.)

Changing the model means editing **two places in sync**:
- the `opus` provider (id, model, key, kind) in `llm-config.js`
- the `AI_PROVIDER` constant in `assets/app.js`

The model ID is overridable at runtime under `models.opus` in `serve.config.json`. The OpenAI-compatible transport (`askOpenAICompatible`/`streamOpenAICompatible`/`buildOpenAIRequestBody`) is kept dormant in `serve.js` for re-adding an OpenAI-style provider later.

## Vercel deployment

The same server runs on Vercel: `api/index.js` wraps `handleRequest` (exported from `serve.js`, which only calls `listen()` when run directly), and `vercel.json` routes **every** path through that one function — nothing is served from Vercel's static layer, so the `/lec` disguise and the `assets/lectures/*.pdf` block behave exactly as locally. `ANTHROPIC_API_KEY` is set as a Vercel environment variable; pushes to `main` auto-deploy via the Vercel↔GitHub integration. MySQL is never reachable from the cloud, so the SQL sandbox always uses in-browser SQLite there, and `data/snapshot.sqlite` is gitignored so `/sql/filestatus` reports absent on Vercel — drag the snapshot into the sandbox instead.

## The stealth disguise is load-bearing

The app intentionally masquerades as a plain PDF viewer; this is a product requirement, not incidental styling — preserve it when changing the UI:
- The brand header and the entire search sidebar are hidden by default (`document.body.classList.add("stealth")`). `/` reveals search; `Esc` steps back toward the bare viewer.
- The chat panel is titled **"Notizen"** and carries no AI branding; the system prompts in `serve.js` explicitly forbid the model from mentioning that it's an AI or that the text is generated.
- It is driven from the keyboard: **Ctrl+Alt+Enter** — or holding **d** while pressing **Enter** — asks the tutor (the sandbox keeps plain Ctrl+Enter for Run); typed `:`-commands in the search box switch state — `:ai` toggles the visible controls, `:new` resets the thread, `:fast` toggles text-only (no slide images) vs vision, and `:sql`/`:db` opens the SQL sandbox. (There is only one model — Claude Fable 5 — so there is no model-selection command.)
- Endpoint names (`/q`, `/llm`, `/lec`, `/sql/*`) are deliberately neutral. The sandbox panel is titled "Abfrage"; a SQL client is unremarkable for a database course.

## Gotchas

- **Yellow highlighting is back, done correctly — don't revert it to a no-op.** The old overlay was removed because it computed absolute-pixel boxes from pdf.js text items that drifted at zoom. The current approach (`getWordBoxes` → `placeHighlights`) computes per-word boxes in **normalized 0..1 page coordinates** and positions them with CSS `%`, so they track the canvas exactly at any zoom or thumbnail size. It runs on both result thumbnails (`.rc-hl`) and the main viewer (`.hl-layer`). Within a text run, words are split and mapped onto the run's true rendered width via canvas `measureText`. If you change rendering, keep boxes normalized and rebuilt per render — do **not** go back to absolute pixels.
- Slide images for the viewer, the thumbnails, and the LLM vision path are produced by rendering the lecture PDF with `disableWorker: true` on the main thread (predictable, cached once per lecture), not via the pdf.js worker. The vision path re-renders the top slides at ~1200px (`renderSlideForVision`) for legibility; thumbnails use a cached 700px bitmap.
- The mysqldump→SQLite conversion (`sql-util.js`) is **best-effort** (it strips `ENGINE=`/`CHARSET`/non-unique `KEY` lines, drops `AUTO_INCREMENT`, converts `ENUM`→`text`, and rewrites backslash-escaped string literals to SQLite doubling). It exists only for the no-MySQL fallback; the accurate path is real local MySQL. Don't rely on it for dialect-exact results.
- `sql.js` loads lazily and only once — `ensureSqlite()` memoizes its init promise. Concurrent callers must share that one promise, or a late init can clobber a freshly-imported in-memory DB with an empty one.

## Quickstart

1. Start the server (`node serve.js` / `start.bat`); the startup log prints whether MySQL is reachable. If it isn't (e.g. `root` needs a password), set `mysql.password` in `serve.config.json` and restart, or rely on the SQLite fallback.
2. **Theory (ERM etc.):** type the question (vision is on by default → the model reads the actual slide images) or paste a screenshot of the question. Ctrl+Alt+Enter (or hold d + Enter).
3. **SQL:** depends on what you're given —
   - **A remote DB server** (host/user/password/dbname, maybe TLS): snapshot it to SQLite — `node mysql-to-sqlite.js --host <h> --user <u> --password <pw> --database <db>` (add `--ssl` / `--ssl-ca ca.pem` / `--ssl-insecure` for TLS). Writes `data/snapshot.sqlite`.
   - **A `.sqlite` file directly**: skip the exporter — just drop it at `data/snapshot.sqlite` (or drag it into the sandbox).
   - Then open the sandbox (`:sql`); it **auto-loads** the snapshot. Write queries and Run (Ctrl+Enter); the tutor's generated `​```sql` answers also get a Run button and are grounded in the imported schema. (The exporter assumes MySQL/MariaDB; a PostgreSQL source would need a `pg` variant. The live-MySQL bridge remains for dialect-exact SQL.)
