# Trusted just-answers tutor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hidden streaming tutor return exam-copy-paste-ready, just-the-answer replies that are grounded in the course slides, with unsupported citations silently stripped.

**Architecture:** Three small changes. (1) A new pure, testable `verifyCitations()` function exposed on the existing UMD `SlideSearchEngine`, reused both client-side and in tests. (2) A rewritten `CHAT_SYSTEM` prompt in `serve.js` encoding the just-answer + honest-citation contract. (3) Browser-side wiring in `assets/app.js`: send top-20 full-text slides, and after the stream re-render the answer through `verifyCitations` to strip bogus `(Folie N)`. No new dependencies, no second LLM call, no server endpoint — the check reads only in-memory slide text.

**Tech Stack:** Vanilla JS (no build step), Node http server (`serve.js`), pdf.js viewer, OpenRouter GLM 5.2 + Anthropic Haiku 4.5, existing `tests/engine.test.js` harness.

## Global Constraints

- The app has **no frontend build step and no framework** — plain `<script>` files loaded by `index.html`. Do not add a bundler, transpiler, or npm runtime dependency. The sole npm dependency is `@anthropic-ai/sdk`.
- `assets/search-engine.js` is a **UMD module** (`module.exports` under Node, `window.SlideSearchEngine` in the browser). Any new reusable function must be exposed the same way so it runs in both contexts.
- **LLM keys live only in the Node server, never in the browser.** The citation verifier must not call any LLM — it only reads slide text already loaded in the browser.
- The **stealth disguise is load-bearing**: the chat panel is titled "Notizen", no AI branding, `/` reveals search, `Esc` steps back, `:commands` in the search box. Do not change the UI, `:commands`, the viewer, or search ranking.
- Routing is unchanged: **text questions → GLM** (`/q`), **pasted-image questions → Haiku** (`/q`). Server-side modality enforcement stays.
- `node tests/engine.test.js` is the only test suite and **exits non-zero if any check fails** — it is the regression gate. After editing client-side JS, hard-refresh with Ctrl+Shift+R.
- Citation rule (verbatim from spec): a citation `(Folie N)` is allowed **only when the model is genuinely drawing that statement from that slide**. If the answer is the model's own reasoning/computation and is not on a slide, it carries **no citation — never a "related" slide**. Unsupported citations are **silently stripped**; the claim stays. The verifier is **best-effort and non-destructive**: on error or missing slide text, leave the citation alone (prefer a missed strip over a false strip).

---

## File Structure

- **Modify:** `assets/search-engine.js` — add and expose `verifyCitations(answerText, slides)`. This file is already UMD and already exposes `fold` / `contentTokens`, which the verifier reuses. Keeps the verifier in the same module as the text-matching primitives it depends on.
- **Modify:** `serve.js` — rewrite the `CHAT_SYSTEM` constant (lines ~211-227) to encode the just-answer + honest-citation contract. No new routes, no new server logic.
- **Modify:** `assets/app.js` — in `runAsk()`: (a) send top-20 full-text slides with a relevance note instead of top-12 × 700 chars; (b) after the stream's final render, run `SlideSearchEngine.verifyCitations(...)` and re-render `streamBodyEl` once.
- **Modify:** `tests/engine.test.js` — append a citation-verifier test block that loads real `slides.json` and asserts keep/strip behavior, exiting non-zero on failure.

---

## Task 1: Add `verifyCitations` to the search engine (TDD)

**Files:**
- Modify: `assets/search-engine.js` (add function inside the factory, expose it near line 455)
- Test: `tests/engine.test.js` (append a new test block at the end, before the final exit-code logic)

**Interfaces:**
- Consumes: `fold(s)` and `contentTokens(text)` already defined inside the same factory (lines 111, 130).
- Produces: `SlideSearchEngine.verifyCitations(answerText, slides)` —
  - `answerText: string` — the raw model answer containing zero or more `(Folie N)` citations.
  - `slides: Array<{page:number, text:string, ...}>` — the full slide array from `data/slides.json` (same shape the engine constructor takes). May be indexed by position; the function must look up a slide by its `.page` field.
  - Returns: `string` — the answer with unsupported `(Folie N)` citations removed, good citations and all non-citation text preserved. Best-effort: on any internal error, returns the original `answerText` unchanged.

**Citation semantics for the implementer:**

- A citation is the token `Folie` (case-insensitive, diacritic-folded) followed by a number, optionally wrapped as `(Folie 47)`, `(Folie S.47)`, `(S. 47)`, `(slide 47)`, or bare `Folie 47`. Scan for the pattern `(?:folie|slide|s\.?)\s*(\d{1,3})` after folding, but operate on the **original** string so stripping preserves the rest of the text. A robust approach: walk the original answer with a regex that matches the parenthesised forms `\(?\s*(?:Folien?|Slides?|S\.?)\s*(\d{1,3}(?:\s*(?:[,;/&]|und|and)\s*\d{1,3})*)\s*\)?` case-insensitively, extract each number, and decide keep/strip per number.
- "Supported" means: the cited page exists in `slides`, **and** at least one non-stopword content token from the **claim sentence** the citation sits in also appears in that slide's folded `contentTokens`. The claim sentence is the substring from the previous sentence boundary (`[.!?\n]` or start) up to the citation. If you cannot isolate a claim sentence, treat the whole line containing the citation as the claim.
- Strip **only the unsupported citation token itself** (e.g. remove ` (Folie 401)` or just the `(Folie 401)`), not the claim. For multi-citations `(Folie 47, Folie 52)`, strip only the unsupported numbers and keep supported ones; if all are unsupported, strip the whole parenthesised group. Tidy leftover double spaces / orphaned punctuation lightly.
- Unparseable refs (no number, or regex doesn't match) are left untouched.

- [ ] **Step 1: Write the failing tests**

Append this block to `tests/engine.test.js`, **before** the existing final `process.exit` / summary code at the bottom of the file. First read the bottom of the file to find the exact insertion point (the existing `pass`/`CASES` summary and any `process.exit`).

```js
// == citation verifier ==
console.log("");
console.log("== citation verifier ==");
const SLIDES_BY_PAGE = new Map(data.slides.map((s) => [s.page, s]));
let vpass = 0, vfail = 0;
function vcase(name, answer, expect) {
  const out = SlideSearchEngine.verifyCitations(answer, data.slides);
  const ok = out === expect;
  if (ok) vpass++; else vfail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log("  in : " + JSON.stringify(answer)); console.log("  out: " + JSON.stringify(out)); console.log("  exp: " + JSON.stringify(expect)); }
}

// 1. supported citation kept — pick a real slide and a term actually on it
const sReal = data.slides[0]; // page 1, text contains "Datenbanken"
vcase("supported citation kept", "Datenbanken sind wichtig (Folie " + sReal.page + ")", "Datenbanken sind wichtig (Folie " + sReal.page + ")");

// 2. page does not exist -> stripped
vcase("missing page stripped", "Etwas erfundenes (Folie 99999)", "Etwas erfundenes");

// 3. real page but claim term not on it -> stripped
const sOther = data.slides[0];
vcase("unsupported claim stripped", "Quantenverschränkung von Tupeln (Folie " + sOther.page + ")", "Quantenverschränkung von Tupeln");

// 4. multiple citations, mixed -> only bad one stripped
const sReal2 = data.slides[1] || data.slides[0];
vcase("mixed citations", "Datenbanken (Folie " + sReal.page + ", Folie 99999)", "Datenbanken (Folie " + sReal.page + ")");

// 5. no citations -> unchanged
vcase("no citations unchanged", "SELECT * FROM kunde;", "SELECT * FROM kunde;");

// 6. unparseable ref -> untouched
vcase("unparseable untouched", "Siehe Folie (unbekannt)", "Siehe Folie (unbekannt)");

// 7. verifier never throws on weird input -> returns input unchanged
let threw = false;
try { SlideSearchEngine.verifyCitations(null, data.slides); } catch (e) { threw = true; }
vcase("null input no throw", threw ? "THREW" : "ok", "ok");
```

Then, at the very end of the file, ensure the exit code includes the verifier failures. Read the existing bottom of the file and update the final exit to consider `vfail` as well — e.g. change the existing `process.exit(...)` line so the exit code is non-zero if **either** the ranking checks or the verifier checks failed. If there is no explicit `process.exit` today, add:

```js
const failed = (typeof fail !== "undefined" ? fail : 0) + vfail;
console.log("");
console.log(`== summary: ${pass + vpass}/${CASES.length + vpass + vfail} passed ==`);
process.exit(failed > 0 ? 1 : 0);
```

(Adjust the `fail` variable name to match whatever the existing ranking summary uses — read the bottom of the file first and reuse its existing variables rather than introducing duplicates.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/engine.test.js`
Expected: the existing ranking checks still print, then under `== citation verifier ==` the cases print **FAIL** with `out` showing the unmodified answer (because `verifyCitations` does not exist yet — it will throw `TypeError: SlideSearchEngine.verifyCitations is not a function`, which the null-input case surfaces as a thrown error). The script exits non-zero.

- [ ] **Step 3: Implement `verifyCitations`**

Inside the factory function in `assets/search-engine.js`, just **above** the `// expose helpers for tests / reuse` block (around line 454), add:

```js
  // --- citation verifier ---------------------------------------------------
  // Verify "(Folie N)" citations in a model answer against the slide texts.
  // A citation is kept only if page N exists in `slides` AND at least one
  // content token of the claim sentence it attaches to appears on that slide.
  // Unsupported citations are silently removed; the claim text is preserved.
  // Best-effort: on any error returns the original answer unchanged.
  function claimTokensFor(answer, citeStart) {
    // sentence = from previous sentence boundary up to the citation
    const before = answer.slice(0, citeStart);
    const m = /[.!?\n][^.!?\n]*$/.exec(before);
    const sentStart = m ? m.index + 1 : 0;
    const sent = answer.slice(sentStart, citeStart);
    const toks = contentTokens(sent).filter((t) => t && t.length >= 2);
    return toks;
  }
  function slideTextForPage(slides, page) {
    for (let i = 0; i < slides.length; i++) {
      if (slides[i] && Number(slides[i].page) === page) return slides[i].text || "";
    }
    return null;
  }
  function citationSupported(answer, citeStart, nums, slides) {
    const claimToks = claimTokensFor(answer, citeStart);
    if (!claimToks.length) return false; // nothing to anchor the claim -> not supported
    for (const n of nums) {
      const txt = slideTextForPage(slides, n);
      if (txt == null) continue; // missing page -> this number unsupported
      const slideToks = new Set(contentTokens(txt));
      // supported if ANY claim token appears on the slide
      if (claimToks.some((t) => slideToks.has(t))) return true;
    }
    return false;
  }
  function verifyCitations(answerText, slides) {
    try {
      if (typeof answerText !== "string" || !answerText) return answerText == null ? "" : String(answerText);
      if (!Array.isArray(slides)) return answerText;
      const CITE = /\(?\s*(?:Folien?|Slides?|S\.?)\s*(\d{1,3}(?:\s*(?:[,;/&]|und|and)\s*\d{1,3})*)\s*\)?/gi;
      let out = "";
      let last = 0;
      let m;
      while ((m = CITE.exec(answerText)) !== null) {
        const nums = m[1].match(/\d{1,3}/g).map(Number);
        // split the match into the supported/unsupported number sub-spans
        // Re-parse the matched span to strip only unsupported numbers.
        const spanStart = m.index;
        const spanEnd = CITE.lastIndex;
        const span = answerText.slice(spanStart, spanEnd);
        const supportedNums = nums.filter((n) => {
          const txt = slideTextForPage(slides, n);
          if (txt == null) return false;
          const slideToks = new Set(contentTokens(txt));
          return claimTokensFor(answerText, spanStart).some((t) => slideToks.has(t));
        });
        out += answerText.slice(last, spanStart);
        if (supportedNums.length === nums.length) {
          // all supported -> keep whole span
          out += span;
        } else if (supportedNums.length === 0) {
          // none supported -> drop the span entirely (and a leading space if present)
          if (out.endsWith(" ")) out = out.replace(/\s+$/, "");
        } else {
          // mixed -> rebuild a minimal "(Folie a, Folie b)" keeping supported numbers
          out += "(" + supportedNums.map((n) => "Folie " + n).join(", ") + ")";
        }
        last = spanEnd;
      }
      out += answerText.slice(last);
      // tidy leftover double spaces / orphaned punctuation from stripping
      out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+\)/g, ")").replace(/\(\s+/g, "(").replace(/[ \t]+$/gm, "");
      return out;
    } catch (e) {
      return (typeof answerText === "string") ? answerText : "";
    }
  }
```

Then expose it next to the other helpers (around line 455):

```js
  SlideSearchEngine.verifyCitations = verifyCitations;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/engine.test.js`
Expected: under `== citation verifier ==` all 7 cases print **PASS**, the ranking checks are unchanged, and the script exits 0. If any verifier case fails, read the `out`/`exp` diff it prints and adjust the matching logic (most likely cause: the chosen `sReal` term — "Datenbanken" — folded vs. the slide's `contentTokens`; confirm with a quick `console.log(SlideSearchEngine.contentTokens(sReal.text))` in a scratch node repl if needed).

- [ ] **Step 5: Commit**

```bash
git add assets/search-engine.js tests/engine.test.js
git commit -m "feat: add verifyCitations to strip unsupported slide citations"
```

---

## Task 2: Rewrite the tutor system prompt

**Files:**
- Modify: `serve.js:211-227` (the `CHAT_SYSTEM` constant)

**Interfaces:**
- Consumes: nothing new (the prompt is a static string sent to GLM/Haiku).
- Produces: a new `CHAT_SYSTEM` string that instructs the model to (a) return only the answer in the format the question implies, (b) put runnable SQL in a single fenced ```sql block with no surrounding prose, (c) cite `(Folie N)` **only** when drawing from that slide, (d) never cite a "related" slide, (e) if no slide covers it, answer from own knowledge with no citation.

- [ ] **Step 1: Replace `CHAT_SYSTEM`**

In `serve.js`, replace the entire `CHAT_SYSTEM = '...'` block (lines ~211-227) with:

```js
const CHAT_SYSTEM =
  'You are an exam tutor for the German university database course "DSCB140 - Datenbanken & Datenkunde". ' +
  'You receive a student QUESTION and several course SLIDES as reference material.\n\n' +
  'OUTPUT RULE — answer ONLY:\n' +
  'Return only the direct answer to exactly what the question asks for. No preamble, no restating the ' +
  'question, no explanation, no "because"/justification, no examples, no sign-off. If the question ' +
  'explicitly asks for a justification ("warum", "erklär", "begründe", "wieso", "erläutere"), give only ' +
  'the requested justification, still tight.\n\n' +
  'FORMAT — let the question decide:\n' +
  'Choose the smallest format that fully answers the question: a computed value, a runnable SQL statement, ' +
  'a bare or numbered list, or one sentence. Never use a fixed template. For SQL, output ONE fenced ```sql ' +
  'block containing only the runnable query — no prose before or after, no "Hier ist die Abfrage:". For a ' +
  'computed value, give just the value (with the unit if any). The output must be copy-paste-ready for an ' +
  'exam.\n\n' +
  'CITATIONS — honest provenance only:\n' +
  'The slides are a reference to cross-check your answer, not a cage. You may reason and compute (normalize ' +
  'a table, write SQL, derive a value) using your own knowledge. Write "(Folie N)" with the GLOBAL page ' +
  'number ONLY for a statement you are actually taking from that slide. If a statement is your own ' +
  'reasoning or computation and is not on any slide, state it with NO citation — NEVER attach a "related" ' +
  'slide to dress up an answer you derived yourself. A citation means "this is on Folie N"; nothing else.\n\n' +
  'If no slide covers the concept, answer from your own knowledge with no citation — that is correct, not ' +
  'a failure. Use **bold** for key terms only when it aids readability. NEVER mention being an AI, a model, ' +
  'or that this text is generated — write as if it were the course\'s own notes. No greetings, no "as an AI".';
```

- [ ] **Step 2: Verify the server still boots and routes**

Run: `node -e "require('./serve.js')"` is not suitable (it starts listening). Instead do a syntax check:
Run: `node --check serve.js`
Expected: no output, exit 0 (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add serve.js
git commit -m "feat: strict just-answers + honest-citation tutor prompt"
```

---

## Task 3: Send top-20 full-text slides as context

**Files:**
- Modify: `assets/app.js:484-490` (the `slidesText` assembly block inside `runAsk`)

**Interfaces:**
- Consumes: `engine.search(q, { limit })` (existing) and `data.slides[r.docId].text` (existing shape).
- Produces: a richer `slidesText` string passed in `textPart`, containing the top 20 slides at full text with a one-line relevance note each. No change to the `messages` shape sent to `/q`.

- [ ] **Step 1: Replace the slide-context assembly**

In `assets/app.js` `runAsk()`, replace this block (lines ~484-490):

```js
        const res = engine.search(q, { limit: 12 });
        slidesText = res.results.slice(0, 12).map((r) =>
          "[Folie " + r.page + " | " + (r.lecture || "") + " | " + (r.title || "") + "]\n" +
          (((data.slides[r.docId] || {}).text) || "").slice(0, 700)
        ).join("\n\n");
```

with:

```js
        const res = engine.search(q, { limit: 20 });
        slidesText = res.results.slice(0, 20).map((r) => {
          const full = (((data.slides[r.docId] || {}).text) || "").trim();
          return "[Folie " + r.page + " | " + (r.lecture || "") + " | " + (r.title || "") +
                 " | score " + (r.score != null ? r.score.toFixed(2) : "-") + "]\n" + full;
        }).join("\n\n");
```

Note: confirm `r.score` exists on results — read the engine's result shape around `assets/search-engine.js:400-412`. If results do not carry a `score` field, drop the `| score ...` segment (keep the rest). The relevance note is primarily the lecture + title; the score is a nice-to-have.

- [ ] **Step 2: Hard-refresh and smoke-check**

Run: `node serve.js` (in one terminal), open `http://localhost:8000`, hard-refresh with Ctrl+Shift+R. Press `/`, type "Was ist die 3. Normalform?", press Ctrl+Enter. Confirm the tutor streams an answer and cites real slides. (Full automated grounding isn't possible here; this is a smoke check that the request still works with the larger context.)

- [ ] **Step 3: Commit**

```bash
git add assets/app.js
git commit -m "feat: send top-20 full-text slides as tutor context"
```

---

## Task 4: Strip unsupported citations after the stream

**Files:**
- Modify: `assets/app.js:546-547` (the post-stream final render in `runAsk`)

**Interfaces:**
- Consumes: `SlideSearchEngine.verifyCitations(answerText, slides)` from Task 1, and `data.slides` (already loaded in `init`).
- Produces: after the stream, the displayed answer has unsupported `(Folie N)` citations removed via a single re-render of `streamBodyEl`.

- [ ] **Step 1: Add the verify+strip after the final render**

In `assets/app.js` `runAsk()`, find the post-stream final render (lines ~546-547):

```js
      assistantTurn.content = acc || "_(keine Antwort)_";
      if (streamBodyEl) { streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content); wireSlideRefs(streamBodyEl); }
```

Replace it with:

```js
      assistantTurn.content = acc || "_(keine Antwort)_";
      if (streamBodyEl) {
        // Trust layer: silently strip any citation whose slide doesn't support the claim.
        let verified = assistantTurn.content;
        try { if (window.SlideSearchEngine && data && data.slides) verified = SlideSearchEngine.verifyCitations(verified, data.slides); }
        catch (e) { /* best-effort: keep original on any error */ }
        if (verified !== assistantTurn.content) assistantTurn.content = verified;
        streamBodyEl.innerHTML = renderMarkdown(assistantTurn.content);
        wireSlideRefs(streamBodyEl);
      }
```

- [ ] **Step 2: Hard-refresh and smoke-check the strip**

With `node serve.js` running, hard-refresh. Ask a question whose answer the model is likely to cite, e.g. "Was bedeutet ACID?". Confirm the streamed answer appears, and any `(Folie N)` shown is a real page whose slide actually relates to ACID. Then ask a question that invites a fabricated citation, e.g. "Erkläre Quantencomputing in Datenbanken" — confirm any `(Folie N)` the model invents gets stripped (the claim stays, the citation vanishes). No console errors.

- [ ] **Step 3: Run the full test suite (regression gate)**

Run: `node tests/engine.test.js`
Expected: all ranking checks AND all 7 verifier cases PASS, exit 0.

- [ ] **Step 4: Commit**

```bash
git add assets/app.js
git commit -m "feat: strip unsupported citations from tutor answers"
```

---

## Self-Review (run after writing, results recorded here)

- **Spec coverage:**
  - Behavior contract §1 (just the answer) → Task 2 prompt. ✓
  - §2 (format follows question, SQL fenced block) → Task 2 prompt. ✓
  - §3 (copy-paste-ready) → Task 2 prompt + Task 3 (full slide text so SQL/definitions aren't truncated). ✓
  - §4 (citation = provenance only, never "related") → Task 2 prompt. ✓
  - §5 (verify + silent strip) → Task 1 verifier + Task 4 wiring. ✓
  - §6 (no slide → answer from knowledge, no citation) → Task 2 prompt. ✓
  - Architecture (prompt + retrieval + client-side verify, no new deps/routes) → Tasks 1-4. ✓
  - Edge cases (missing page, unsupported claim, mixed multi-cite, unparseable, no-cite, throw-safe, image no-op) → Task 1 tests. ✓
  - Testing (verifier test in engine.test.js, exits non-zero) → Task 1 Step 1. ✓
- **Placeholder scan:** No TBD/TODO; every code step has full code. ✓
- **Type consistency:** `verifyCitations(answerText, slides) -> string` is identical in Task 1 (definition), Task 1 tests (calls), and Task 4 (call site). `data.slides` shape reused everywhere. ✓
