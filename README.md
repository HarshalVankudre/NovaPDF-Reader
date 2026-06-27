# DB Slide Finder — DSCB140

A fast, offline, in-browser search engine + PDF viewer over the combined lecture
slides (317 slides, VL1–VL7). Paste a database question and the most relevant
slides are ranked **live as you type** (no Enter, no server round-trip). Click a
result to open that slide with the matching terms highlighted.

## Run it

Double-click **`start.bat`** (or run it from a terminal):

```
node serve.js
```

then open <http://localhost:8000>. It must be served over http — opening
`index.html` directly (file://) won't work because the browser blocks loading the
data/PDF.

> Use the bundled **`serve.js`** (Node), not Python's `http.server` — the latter
> drops/empties large files on Windows, which breaks PDF loading. The slides are
> split into small per-lecture PDFs that load on demand, and the loader retries
> in chunks, so flaky connections recover automatically.

> Tip: hard-refresh with **Ctrl+Shift+R** after any code change to bypass the
> browser cache.

## Hidden tutor chat (stealth, streaming)

**Looks like a plain PDF viewer by default** — the page opens with just the slide
+ page/zoom toolbar; the brand header and the entire search sidebar are hidden.
Press **`/`** to reveal the search; **Esc** collapses it back to the bare viewer.

The visible search and hidden tutor are separate. BM25 ranks the 317 slides live
in the sidebar; Ctrl+Enter sends only the typed question (plus any screenshot
you pasted) to the tutor. It does not attach extracted slide text, rendered
lecture slides, or automatic `(Folie N)` citations. Each question is standalone
and streams into the "Notizen" panel with **no AI branding**.

| Key / command | Action |
|---|---|
| **`/`** | Reveal the hidden search sidebar (focus it). Brand stays hidden. |
| **Ctrl + Enter** (in search) | Ask the tutor (streams into the "Notizen" pane) |
| **Esc** | Step back: close notes → clear query → hide search → plain viewer |
| **← / →** | Previous / next page (works in plain-viewer mode too) |
| type `:new` ↵ | Start a fresh conversation (clears the thread) |
| type `:ai` ↵ | Show/hide the visible control bar (off by default) |

The proxy endpoints are `/q` (streaming chat) and `/llm` (single-shot, legacy) —
neutral names, with the key kept server-side only.

The API key lives **only in the Node server** (never in the browser). Set your
OpenRouter key, then restart the server:

```powershell
# Recommended — environment variable (never written to disk):
setx OPENROUTER_API_KEY "sk-or-..."
# reopen the terminal so the variable takes effect, then: node serve.js
```

Or copy `serve.config.example.json` → `serve.config.json` (gitignored) and paste
your key there. The tutor defaults to Qwen 3.5 Flash with reasoning disabled;
the model ID is configurable under `models.tutor`.

## How it works

```
index.html ─┬─ assets/pdf.min.js          (PDF.js, vendored — fully offline)
            ├─ assets/pdf.worker.min.js
            ├─ assets/search-engine.js     (the search engine — no dependencies)
            ├─ assets/tutor-message.js     (question + optional screenshot payload)
            ├─ assets/app.js               (UI: viewer + live search wiring)
            ├─ assets/style.css            (GeeksforGeeks-style UI)
            ├─ assets/slides.pdf           (the merged 317-slide PDF)
            └─ data/slides.json            (per-slide text + lecture metadata)
```

### The search engine (`search-engine.js`)

Built from scratch on the proven **Okapi BM25** ranking function over an inverted
index, plus a domain-intelligence layer tuned for a German DB course:

- **German-aware folding** — `ä/ö/ü/ß` normalized, so "primär" = "primar".
- **Prefix expansion** — typing `norm` already matches *Normalform* / *Normalisierung* (drives the as-you-type feel).
- **Light stemming + fuzzy fallback** — *Transaktion ↔ Transaktionen*; typos like *primärschlüsel* still hit.
- **Bilingual synonym map** — *Primärschlüssel ↔ primary key ↔ PK*, *Verbund ↔ JOIN*, etc.
- **Title (BM25F) + coverage + proximity boosts** — slides that answer *more* of the question rank higher.

A full ranked query runs in **~0.3 ms** for all 317 slides.

Verify quality/latency any time:

```
node tests/engine.test.js
```

## Editing / extending

- **Re-extract slide text** (after changing the source PDFs):
  `python build_index.py` → rebuilds `data/slides.json`.
- **Add search synonyms**: edit `SYN_GROUPS` near the top of
  `assets/search-engine.js` (folded tokens, e.g. add `["sicht","view"]`).
- **Deep-link a query**: `http://localhost:8000/?q=ACID` runs that search on load
  (the URL updates as you type, so searches are shareable).

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | focus the search box |
| `←` / `→` | previous / next slide |
| `Enter` (in search) | open the top result |
| `Esc` (in search) | clear |

## Ideas for "more functions later"

- Semantic search (embeddings) fused with BM25 via Reciprocal Rank Fusion.
- Continuous-scroll viewer + in-PDF text selection layer.
- Bookmarks / notes per slide, exportable.
- Filter results by lecture (VL1–VL7).
