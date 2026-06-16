# NovaPDF Reader

A fast, offline, in-browser **PDF viewer with full-text search**. Open a
document, page or zoom through it, and search the text **live as you type** — the
most relevant pages are ranked instantly and clicking a result jumps straight to
that page with the matching terms highlighted.

## Run it

Double-click **`start.bat`** (or run it from a terminal):

```
node serve.js
```

then open <http://localhost:8000>. It must be served over http — opening
`index.html` directly (file://) won't work because the browser blocks loading the
PDF data locally.

> Use the bundled **`serve.js`** (Node), not Python's `http.server` — the latter
> drops/empties large files on Windows, which breaks PDF loading. Documents are
> split into small per-section PDFs that load on demand, and the loader retries
> in chunks, so flaky connections recover automatically.

> Tip: hard-refresh with **Ctrl+Shift+R** after any change to bypass the browser
> cache.

## How it works

```
index.html ─┬─ assets/pdf.min.js          (PDF.js, vendored — fully offline)
            ├─ assets/pdf.worker.min.js
            ├─ assets/search-engine.js     (the search engine — no dependencies)
            ├─ assets/app.js               (UI: viewer + live search wiring)
            ├─ assets/style.css            (UI styling)
            ├─ assets/slides.pdf           (the merged document)
            └─ data/slides.json            (per-page text + metadata)
```

### The search engine (`search-engine.js`)

Built from scratch on the proven **Okapi BM25** ranking function over an inverted
index, with a few quality-of-life refinements:

- **Accent-aware folding** — `ä/ö/ü/ß` normalized, so "primär" = "primar".
- **Prefix expansion** — typing `norm` already matches longer words (drives the
  as-you-type feel).
- **Light stemming + fuzzy fallback** — singular ↔ plural; small typos still hit.
- **Synonym map** — configurable equivalent terms.
- **Title + coverage + proximity boosts** — pages that answer *more* of the query
  rank higher.

A full ranked query runs in **~0.3 ms** across the whole document.

Verify quality/latency any time:

```
node tests/engine.test.js
```

## Editing / extending

- **Re-extract page text** (after changing the source PDFs):
  `python build_index.py` → rebuilds `data/slides.json`.
- **Add search synonyms**: edit `SYN_GROUPS` near the top of
  `assets/search-engine.js`.
- **Deep-link a query**: `http://localhost:8000/?q=example` runs that search on
  load (the URL updates as you type, so searches are shareable).

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | focus the search box |
| `←` / `→` | previous / next page |
| `Enter` (in search) | open the top result |
| `Esc` (in search) | clear |

## Ideas for later

- Semantic search (embeddings) fused with BM25 via Reciprocal Rank Fusion.
- Continuous-scroll viewer + in-PDF text selection layer.
- Bookmarks / notes per page, exportable.
- Filter results by section.
