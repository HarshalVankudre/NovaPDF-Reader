# NovaPDF Reader

A lightweight, browser-based PDF reader for the included lecture slides. Browse
317 pages across seven lectures in a clean reading view, with simple navigation,
zoom controls, and text search.

## Quick start on Windows

1. Install [Node.js](https://nodejs.org/) with npm included.
2. Open the project folder and double-click **`start.bat`**.
3. The reader opens automatically in your default browser.

The launcher installs missing dependencies on the first run, then starts the
local server. Keep its terminal window open while reading; close it to stop
the app. The first installation needs an internet connection. Once set up, the
included PDFs can be read offline.

If the browser does not open automatically, visit <http://localhost:8000>.

## Reading controls

- Use the arrow buttons to move between pages, or enter a page number directly.
- Use **+**, **−**, and **Fit** to adjust the page size.
- Choose a lecture from the toolbar to jump to its first page.
- Press **`/`** to open search. Matching words are highlighted on the page and
  in result previews; click a result to read that page.
- Press **Esc** to return to the reading view.

| Shortcut | Action |
| --- | --- |
| `←` / `PgUp` | Previous page |
| `→` / `PgDn` | Next page |
| `Home` / `End` | First / last page |
| `Ctrl` + mouse wheel | Zoom at the cursor |
| `/` | Open search |
| `Esc` | Return to the reading view |

## Start from a terminal

From the project folder, run:

```sh
npm install
node serve.js
```

Then open <http://localhost:8000>. Use the bundled Node.js server to run the
reader; opening `index.html` directly is not supported.
