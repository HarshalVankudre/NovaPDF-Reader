# Separate Search and Secret Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep BM25 search visible and unchanged while ensuring hidden tutor requests contain only the typed question and optional pasted screenshots.

**Architecture:** Add a small UMD payload builder that can run both in the browser and in Node tests. `assets/app.js` delegates tutor-message construction to it and no longer reads BM25 results or renders slide images for model requests. `serve.js` keeps its existing streaming provider integration but uses a general tutor prompt without slide-grounding or citation requirements.

**Tech Stack:** Plain browser JavaScript, Node.js CommonJS tests, Node `http` server, OpenAI-compatible streaming API.

---

## File structure

- Create `assets/tutor-message.js`: provider-neutral construction of one user turn from text and optional screenshots.
- Create `tests/tutor-message.test.js`: regression tests proving tutor payloads never include slide context.
- Modify `index.html`: load the payload builder before `assets/app.js`.
- Modify `assets/app.js`: remove automatic BM25/slide-image context from `runAsk` and call the payload builder.
- Modify `serve.js`: remove slide-only and citation rules from the streaming tutor system prompt.
- Modify `tests/server.test.js`: verify the upstream prompt is general chat and the user content passes through unchanged.
- Modify `README.md`, `AGENTS.md`, and `CLAUDE.md`: document the separation between visible BM25 search and hidden normal chat.

### Task 1: Add a testable tutor payload builder

**Files:**
- Create: `tests/tutor-message.test.js`
- Create: `assets/tutor-message.js`

- [ ] **Step 1: Write the failing payload tests**

Create `tests/tutor-message.test.js`:

```js
"use strict";

const assert = require("assert");
const { buildTutorMessage } = require("../assets/tutor-message.js");

const textOnly = buildTutorMessage("  Was ist eine Relation?  ", []);
assert.strictEqual(textOnly.text, "Was ist eine Relation?");
assert.deepStrictEqual(textOnly.messages, [{
  role: "user",
  content: [{ type: "text", text: "Was ist eine Relation?" }],
}]);

const screenshot = {
  media_type: "image/png",
  data: "abc123",
  dataUrl: "data:image/png;base64,abc123",
};
const withScreenshot = buildTutorMessage("Löse Aufgabe 2", [screenshot]);
assert.match(withScreenshot.text, /^Löse Aufgabe 2/);
assert.deepStrictEqual(withScreenshot.messages[0].content[1], {
  type: "image",
  media_type: "image/png",
  data: "abc123",
});

for (const payload of [textOnly, withScreenshot]) {
  const wire = JSON.stringify(payload.messages);
  assert.doesNotMatch(wire, /Folie|Relevante Folien|lecture|slide/i);
}

console.log("tutor message payload checks passed");
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tests/tutor-message.test.js
```

Expected: failure with `Cannot find module '../assets/tutor-message.js'`.

- [ ] **Step 3: Implement the minimal UMD payload builder**

Create `assets/tutor-message.js`:

```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TutorMessageBuilder = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCREENSHOT_INSTRUCTION =
    "Das Bild enthält den gesamten Kontext der Aufgabe/Frage. Löse bzw. beantworte sie vollständig und " +
    "STRUKTURIERT: gliedere mit klaren Überschriften/Abschnitten, gib je Schritt eine kurze Begründung, " +
    "und schließe mit einem knappen Ergebnis. Nutze Listen, nummerierte Schritte oder eine Tabelle, wo es passt.";

  function buildTutorMessage(question, images) {
    const q = String(question || "").trim();
    const imgs = Array.isArray(images) ? images : [];
    const text = imgs.length ? (q ? q + "\n\n" : "") + SCREENSHOT_INSTRUCTION : q;
    const content = [{ type: "text", text }];
    for (const image of imgs) {
      content.push({
        type: "image",
        media_type: image.media_type || "image/png",
        data: image.data,
      });
    }
    return { text, messages: [{ role: "user", content }] };
  }

  return { buildTutorMessage };
});
```

- [ ] **Step 4: Run the payload tests and verify GREEN**

Run:

```powershell
node tests/tutor-message.test.js
```

Expected: `tutor message payload checks passed`.

- [ ] **Step 5: Commit the isolated builder**

```powershell
git add assets/tutor-message.js tests/tutor-message.test.js
git commit -m "Add provider-neutral tutor message builder"
```

### Task 2: Remove BM25 and slide images from hidden tutor requests

**Files:**
- Modify: `index.html:116-118`
- Modify: `assets/app.js:493-638`

- [ ] **Step 1: Load the tested builder before the UI controller**

Change the script block in `index.html` to:

```html
  <script src="assets/pdf.min.js" defer></script>
  <script src="assets/search-engine.js" defer></script>
  <script src="assets/tutor-message.js" defer></script>
  <script src="assets/app.js" defer></script>
```

- [ ] **Step 2: Remove slide-vision state and rendering code**

Delete from `assets/app.js`:

```js
  const VISION_SLIDES = 2;
  const visionCache = new Map();
```

Delete the complete `getSlideImageForVision(globalPage, targetW)` function. Keep `processImageBlob`, because pasted screenshots still use it.

- [ ] **Step 3: Replace RAG construction in `runAsk`**

Change the guard to remove the search-engine dependency:

```js
    if ((!q && !imgs.length) || aiStreaming) return;
```

Replace the provider, BM25 search, slide excerpt, rendered-slide, and manual block-construction section with:

```js
      const built = window.TutorMessageBuilder.buildTutorMessage(q, imgs);
      const textPart = built.text;
      const messages = built.messages;
```

Keep the existing `aiThread`, panel rendering, streaming reader, and error-handling code. Remove the later duplicate declaration:

```js
      const messages = [{ role: "user", content: blocks }];
```

Change the `/q` request body to:

```js
        body: JSON.stringify({ messages }),
```

- [ ] **Step 4: Run payload and syntax checks**

Run:

```powershell
node tests/tutor-message.test.js
node --check assets/tutor-message.js
node --check assets/app.js
```

Expected: payload test passes and both syntax checks exit with code 0.

- [ ] **Step 5: Commit browser integration**

```powershell
git add index.html assets/app.js
git commit -m "Separate hidden chat from BM25 search context"
```

### Task 3: Make the server prompt normal chat

**Files:**
- Modify: `tests/server.test.js:30-75`
- Modify: `serve.js:232-249`

- [ ] **Step 1: Add failing upstream prompt assertions**

In `testGrokLowReasoning`, after the existing `captured.stream` assertion, add:

```js
    assert.doesNotMatch(captured.messages[0].content, /provided slide|Folie N|slides do not contain/i,
      "system prompt must not require slide context or citations");
    assert.deepStrictEqual(captured.messages[1], {
      role: "user",
      content: [{ type: "text", text: "Sag Hallo" }],
    }, "the user message should pass upstream without injected slide context");
```

- [ ] **Step 2: Run the server test and verify RED**

Run:

```powershell
node tests/server.test.js
```

Expected: failure at `system prompt must not require slide context or citations`.

- [ ] **Step 3: Replace the streaming tutor system prompt**

Keep the existing response-length, formatting, same-language, screenshot, stealth, and no-greeting rules. Replace the slide-grounding portions with:

```js
const CHAT_SYSTEM =
  'You are an expert tutor for the German university database course "DSCB140 - Datenbanken & Datenkunde". ' +
  'Answer the student\'s question directly in the SAME language as the question. You may receive a screenshot ' +
  'the student pasted (e.g. an exam question or a diagram) - read it and answer it directly. ' +
  'Match the answer length to what the question genuinely needs - no more, no less. ' +
  'For a simple, factual, or multiple-choice question: reply with ONLY the answer - a single short sentence ' +
  '(for multiple choice, just the correct option), and no explanation or justification unless the student ' +
  'asks for it (e.g. "warum", "erklär", "begründe", "wieso", "erläutere"). For a question that genuinely ' +
  'needs more - explain in depth, compare, derive step by step, write non-trivial SQL, or list several ' +
  'things - give a COMPLETE answer using short bullets, numbered steps, or a fenced ```sql block as ' +
  'appropriate, and never cut it off mid-thought. In all cases stay tight: no preamble, no restating the ' +
  'question, no summary or sign-off, no padding. Default to concise; expand only when the content truly ' +
  'requires it. Use **bold** for key terms. NEVER mention being an AI, a model, or that this text is generated - ' +
  'write as if it were the course\'s own notes. No greetings, no "as an AI".';
```

- [ ] **Step 4: Run server regression checks and verify GREEN**

Run:

```powershell
node tests/server.test.js
```

Expected:

```text
server regression checks passed
grok low-reasoning end-to-end check passed
```

- [ ] **Step 5: Commit the server prompt change**

```powershell
git add serve.js tests/server.test.js
git commit -m "Make hidden tutor answer without slide context"
```

### Task 4: Update architecture documentation

**Files:**
- Modify: `README.md:28-36`
- Modify: `AGENTS.md:7,40,46,59`
- Modify: `CLAUDE.md:7,40,46,59`

- [ ] **Step 1: Update the behavior descriptions**

Document these exact facts:

- BM25 search remains the visible slide-finding feature.
- Hidden chat is independent and sends only the typed question plus optional pasted screenshots.
- The chat no longer receives extracted slide text, rendered slide images, or automatic `(Folie N)` citations.
- PDF rendering still uses the main thread for viewer pages, but there is no LLM slide-vision path.

- [ ] **Step 2: Check documentation for stale RAG claims**

Run:

```powershell
Select-String -Path README.md,AGENTS.md,CLAUDE.md -Pattern 'does RAG|chat does RAG|BM25 slide text|LLM vision path|grounded answer'
```

Expected: no matches.

- [ ] **Step 3: Commit documentation updates**

```powershell
git add README.md AGENTS.md CLAUDE.md
git commit -m "Document independent BM25 search and hidden chat"
```

### Task 5: Full verification

**Files:**
- Verify only.

- [ ] **Step 1: Run all automated tests**

```powershell
node tests/tutor-message.test.js
node tests/engine.test.js
node tests/server.test.js
```

Expected: all commands exit 0 with no failed ranking or server checks.

- [ ] **Step 2: Run syntax validation**

```powershell
node --check assets/tutor-message.js
node --check assets/app.js
node --check serve.js
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the final diff**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors. Any remaining modified files must be pre-existing user work or the intended changes listed above.

- [ ] **Step 4: Browser smoke test**

Run:

```powershell
node serve.js
```

At `http://localhost:8000`, verify:

1. Typing a database query still immediately updates BM25 slide results.
2. Ctrl+Enter opens “Notizen” and streams an answer.
3. The `/q` request contains only the question for text chat.
4. Pasting a screenshot sends that screenshot, without rendered lecture slides.
5. Search results and slide navigation remain operational.
