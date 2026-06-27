# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An offline, in-browser study tool over 317 lecture slides of a German university database course (DSCB140, lectures VL1–VL7). It combines live-as-you-type relevance search (with the matched words highlighted **in yellow** on the slides and thumbnails), a pdf.js slide viewer, a hidden streaming LLM "tutor" that does RAG over the slides (vision-grounded — it reads the actual slide images), and a **SQL sandbox** that runs queries against an imported exam database (local MySQL, or in-browser SQLite as a fallback). No frontend build step and no framework — `index.html` loads plain `<script>` files directly.

## Commands

```
node serve.js                          # run the app → http://localhost:8000 (or double-click start.bat)
npm test                               # runs all 5 node test suites (see below); exits non-zero on any failure
node mysql-to-sqlite.js --database DB  # snapshot a live MySQL DB → data/exam.sqlite (the app auto-loads it)
node tests/engine.test.js              # just the search-engine ranking checks + latency benchmark
python build_index.py                  # rebuild data/slides.json from the source PDFs (needs PyMuPDF or pypdf)
npm install                            # installs deps: @anthropic-ai/sdk, mysql2 (pure-JS), sql.js (WASM)
```

- Must be served over **http** — opening `index.html` via `file://` is blocked by the browser and shows a help screen instead.
- `npm test` runs `engine` + `llm-config` + `client-provider` + `sql-util` + `server` suites. `tests/engine.test.js` checks ranked results against ground-truth page ranges and **exits non-zero if any ranking check fails**, so it's the regression gate when changing the engine. `tests/sql-util.test.js` covers the mysqldump→SQLite cleaning.
- After editing client-side JS, **hard-refresh with Ctrl+Shift+R** — browsers cache the plain script files aggressively.
- **Never** serve this with Python's `http.server`: it drops/empties large files on Windows and breaks PDF loading. Use the bundled `serve.js`.

## API keys & config

LLM keys live only in the Node server, never in the browser. Text questions use `OPENROUTER_API_KEY` (with `OPEN_ROUTER_API_KEY` accepted for compatibility); image/vision questions use `ANTHROPIC_API_KEY` (one key powers both `sonnet` and `haiku`). The server loads process environment variables first, then `.env` / `.env.txt`, then `serve.config.json` (gitignored; copy from `serve.config.example.json`). Config/keys are read from `ROOT` by default, or from `SLIDEFINDER_CONFIG_DIR` if set (lets you keep secrets outside the served dir; the server tests use it to simulate a key-less environment). **Restart the server after changing keys** — config is read once at startup.

For the SQL sandbox, optionally configure local MySQL under `mysql` in `serve.config.json` (or `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` env vars). If MySQL is unreachable (e.g. `root` needs a password), the browser silently falls back to in-browser SQLite.

## Architecture

Three independent layers, tied together by one invariant: the **global page number** (1–317) is the universal key. It is identical across `data/slides.json`, the merged viewer PDF, the per-lecture PDFs, and the `(Folie N)` citations the LLM emits — so a search hit, a viewer page, and a cited slide all refer to the same number.

**1. Server — `serve.js`** (Node `http`, no framework). Three jobs:
   - Static file server with HTTP range support (needed to stream the large PDFs).
   - LLM proxy so keys stay server-side. Custom routes:
     - `GET /lec/<n>` — streams `assets/lectures/vl<n>.pdf` as `text/plain; charset=x-user-defined`. Serving it as text rather than `application/pdf` is a deliberate disguise so download managers don't intercept it. This is the **only** way lecture PDFs are exposed (no direct `.pdf` URL); the browser fetches the raw bytes and hands them to pdf.js.
     - `POST /q` — streaming tutor chat (token-by-token), with timeout + retry + ordered provider fallback (see Providers).
     - `POST /llm` — single-shot JSON answer (legacy).
   - SQL bridge to a local MySQL (via pure-JS `mysql2`): `GET /sql/status`, `GET /sql/schema`, `POST /sql/query`, `POST /sql/import`, plus `GET /sql/filestatus` + `GET /sql/file` which expose the prebuilt SQLite snapshot (`data/exam.sqlite`). Optional — if `mysql2` is missing or MySQL is unreachable, the client uses SQLite instead.

**2. Search engine — `assets/search-engine.js`** — dependency-free Okapi BM25 over an inverted index, plus a German-DB intelligence layer (diacritic folding, prefix expansion for the as-you-type feel, light stemming, bounded-edit fuzzy fallback, a bilingual synonym map, and title/coverage/proximity/**ordered-phrase** boosts). UMD module: the same file runs in the browser (`window.SlideSearchEngine`) and under Node (for the test). A full ranked query over 317 slides is ~1 ms. Tune relevance via `SYN_GROUPS` (synonym/concept bridges) and the BM25 constructor options (`k1`, `b`, `titleBoost`, `coverageWeight`, `proximityWeight`, `phraseWeight`) near the top of the file. `_phrase()` rewards query words appearing in the typed order (a contiguous in-order run); `highlightHTML()` wraps matched words in `<mark>` for snippets. SQL keywords that are also stopwords (e.g. `BETWEEN`) are kept searchable.

**3. UI controller — `assets/app.js`** — wires everything: debounced live search, the pdf.js canvas viewer (rendered from the in-memory `/lec` bytes, cached per lecture), the result panel (rich cards with thumbnail + yellow word-highlight overlay + highlighted snippet in search mode; a plain page-navigator grid in browse mode), the **yellow match overlay** on both thumbnails and the main viewer (see Gotchas), the hidden tutor chat, and the SQL sandbox hooks. Text questions send the top-12 BM25 slides as text **plus the top-3 as rendered images** (vision grounding) and the imported DB schema if present — routed to the vision chain (Claude) so the model can read ER diagrams/SQL. `:fast` disables the images for a quick text-only GLM answer. A pasted screenshot is a self-contained question routed to the vision chain with no slide context. Generated `​```sql` blocks get a **Run** button that executes in the sandbox.

**4. SQL sandbox — `assets/sandbox.js` + `assets/sql-util.js`** — `window.SqlSandbox` (a right-side drawer opened with the toolbar **SQL** button or `:sql`). Two engines, auto-selected: the local-MySQL bridge (exam-exact dialect, preferred) or in-browser SQLite via `sql.js` (vendored at `assets/sql-wasm.js` + `assets/sql-wasm.wasm`, loaded lazily and memoized via `ensureSqlite`, fully offline). The importer accepts: a **binary `.sqlite` snapshot file** (detected by magic header → loaded directly via `new SQL.Database(bytes)`, instant, exact), a mysqldump/`.sql` script, or CSV-per-table. `assets/sql-util.js` is a pure, Node-testable UMD module that splits statements, strips `CREATE DATABASE`/`USE`, best-effort-converts a mysqldump to SQLite (`toSqlite`), and builds CSV→SQL. On open, the sandbox checks `/sql/filestatus` and **auto-loads `data/exam.sqlite`** if present (the fast exam-day path).

**Exam-day SQL snapshot — `mysql-to-sqlite.js`** (Node CLI, run by hand on exam day). Connects to the live MySQL with given credentials and writes a single SQLite file (`data/exam.sqlite` by default) using `mysql2` (streaming read) + `sql.js` (build/export), one transaction per table. This is the *intended* exam-day path: snapshot once → the app auto-loads the binary file instantly (no dump-dialect cleaning, exact data). SQLite dialect still differs from MySQL for some functions; `serve.config.json`'s `mysql` block / `MYSQL_*` env vars provide default credentials so usually you only pass `--database`. Supports TLS via `--ssl` / `--ssl-ca <file>` / `--ssl-cert`/`--ssl-key` / `--ssl-insecure` (or an `ssl` object in the config `mysql` block) for remote/cloud MySQL. The file is gitignored (private data). If the exam DB is itself a `.sqlite` file, skip this and load it directly; PostgreSQL would need a separate `pg`-based variant.

**Data pipeline — `build_index.py`** (offline, run by hand). Reads the 7 source `DSCB140 - VL*.pdf` files **from the parent directory** (`..\`, i.e. `...\Vorlesung`) — those source PDFs are **not in this repo**; only the split `assets/lectures/vl*.pdf` and the merged `assets/slides.pdf` are. It extracts per-page text plus a guessed title into `data/slides.json`, tagging each global page with its lecture.

## Providers — chains, modality enforcement, keep three places in sync

Three providers: `glm` (OpenRouter `z-ai/glm-5.2`, `provider.sort: "throughput"`), `sonnet` (Anthropic `claude-sonnet-4-6`), `haiku` (Anthropic `claude-haiku-4-5`). `sonnet`/`haiku` share `ANTHROPIC_API_KEY`. Requests don't pick a single provider — `providerChainForMessages()` (in `llm-config.js`) returns an **ordered fallback chain**:
- **text-only** → `[<your selected model>, glm, sonnet, haiku]` (fast GLM first, Claude as resilient fallback).
- **any image content** → `[sonnet, haiku]` — **modality enforcement**: images never fall back to a text-only model, regardless of the client's hint.

`streamWithFallback()` (in `serve.js`) tries each provider in order; if one fails *before* emitting a token (error, 5xx, or a `FIRST_TOKEN_MS` timeout) it transparently moves to the next. Once tokens have streamed it commits to that provider. The OpenAI path also retries transient (429/5xx/network) errors once. This is the exam-day safety net — a single API outage doesn't break the tutor.

Adding/removing/renaming a provider means editing **all three**:
- providers, keys, and the chain in `llm-config.js`
- the `<select id="aiProvider">` options in `index.html`
- `AI_PROVIDERS` (and `PROVIDER_ALIASES`) in `assets/app.js` (drives the `:provider` typed commands)

Model IDs are overridable at runtime under `models` in `serve.config.json` (`glm`, `sonnet`, `haiku`).

## The stealth disguise is load-bearing

The app intentionally masquerades as a plain PDF viewer; this is a product requirement, not incidental styling — preserve it when changing the UI:
- The brand header and the entire search sidebar are hidden by default (`document.body.classList.add("stealth")`). `/` reveals search; `Esc` steps back toward the bare viewer.
- The chat panel is titled **"Notizen"** and carries no AI branding; the system prompts in `serve.js` explicitly forbid the model from mentioning that it's an AI or that the text is generated.
- It is driven from the keyboard: **Ctrl+Enter** asks the tutor; typed `:`-commands in the search box switch state — `:ai` toggles the visible controls, `:new` resets the thread, `:glm`/`:sonnet`/`:haiku` select the text model (`:claude`/`:opus` alias to sonnet), `:fast` toggles text-only (no slide images, quick GLM) vs vision, and `:sql`/`:db` opens the SQL sandbox.
- Endpoint names (`/q`, `/llm`, `/lec`, `/sql/*`) are deliberately neutral. The sandbox panel is titled "Abfrage"; a SQL client is unremarkable for a DB exam.

## Gotchas

- **Yellow highlighting is back, done correctly — don't revert it to a no-op.** The old overlay was removed because it computed absolute-pixel boxes from pdf.js text items that drifted at zoom. The current approach (`getWordBoxes` → `placeHighlights`) computes per-word boxes in **normalized 0..1 page coordinates** and positions them with CSS `%`, so they track the canvas exactly at any zoom or thumbnail size. It runs on both result thumbnails (`.rc-hl`) and the main viewer (`.hl-layer`). Within a text run, words are split and mapped onto the run's true rendered width via canvas `measureText`. If you change rendering, keep boxes normalized and rebuilt per render — do **not** go back to absolute pixels.
- Slide images for the viewer, the thumbnails, and the LLM vision path are produced by rendering the lecture PDF with `disableWorker: true` on the main thread (predictable, cached once per lecture), not via the pdf.js worker. The vision path re-renders the top slides at ~1200px (`renderSlideForVision`) for legibility; thumbnails use a cached 700px bitmap.
- The mysqldump→SQLite conversion (`sql-util.js`) is **best-effort** (it strips `ENGINE=`/`CHARSET`/non-unique `KEY` lines, drops `AUTO_INCREMENT`, converts `ENUM`→`text`, and rewrites backslash-escaped string literals to SQLite doubling). It exists only for the no-MySQL fallback; the accurate path is real local MySQL. Don't rely on it for exam-exact results.
- `sql.js` loads lazily and only once — `ensureSqlite()` memoizes its init promise. Concurrent callers must share that one promise, or a late init can clobber a freshly-imported in-memory DB with an empty one.

## Exam-day quickstart

1. Start the server (`node serve.js` / `start.bat`); the startup log prints whether MySQL is reachable. If it isn't (e.g. `root` needs a password), set `mysql.password` in `serve.config.json` and restart, or rely on the SQLite fallback.
2. **Theory (ERM etc.):** type the question (vision is on by default → Claude reads the actual slide images) or paste a screenshot of the exam question. Ctrl+Enter.
3. **SQL:** depends on what the exam hands you —
   - **A remote DB server** (host/user/password/dbname, maybe TLS): snapshot it to SQLite — `node mysql-to-sqlite.js --host <h> --user <u> --password <pw> --database <db>` (add `--ssl` / `--ssl-ca ca.pem` / `--ssl-insecure` for TLS). Writes `data/exam.sqlite`.
   - **A `.sqlite` file directly**: skip the exporter — just drop it at `data/exam.sqlite` (or drag it into the sandbox).
   - Then open the sandbox (**SQL** button / `:sql`); it **auto-loads** the snapshot. Write queries and Run (Ctrl+Enter); the tutor's generated `​```sql` answers also get a Run button and are grounded in the imported schema. (The exporter assumes MySQL/MariaDB; a PostgreSQL source would need a `pg` variant. The live-MySQL bridge remains for exam-exact dialect.)
