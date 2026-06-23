# Trusted just-answers tutor mode

**Date:** 2026-06-24
**Goal:** Make the hidden streaming tutor produce precise, exam-copy-paste-ready answers that are trustworthy for the DSCB140 exam.

## Problem

The user studies for the DSCB140 exam with this app. Their felt pain is **reliability (E)**: they cannot fully trust the tutor's answers under exam pressure. Specifically they want:

- **Just the answer.** No explanation, no "because", no restating the question, no sign-off — only the substantive thing the question asks for, so it can be copied into an exam blindly.
- **Format chosen by the model** based on what the question asks (a computed number, a runnable SQL block, a list, one line) — not a hardcoded output template. "Let the model decide what is needed."
- **Copy-paste-ready.** SQL in a single fenced ```sql block with no surrounding prose; theory answers verbatim-ready.
- **Precise and trusted.** Grounded in *this course's* slides so the answer matches the professor's terminology and definitions, not a generic textbook version.

## Key grounding decision (from brainstorming)

The slides are a **reference to cross-check the answer**, not the only source the model may use. Consequences:

- The model is allowed to reason and compute (normalize a table, write SQL, derive a value) using its own knowledge.
- A citation `(Folie N)` is a **claim of provenance**: "I am stating this because it is on Folie N." It is allowed **only** when the model is genuinely drawing from that slide.
- If the answer is the model's own reasoning/computation and is not actually on a slide, it carries **no citation** — never a "related" slide. Citing a slide the answer didn't actually use is forbidden.
- It is **not a failure** if the exact answer isn't on a slide (a worked SQL query or computed value won't be). That answer simply has no citation.
- When the self-check finds a citation the cited slide does **not** support, the citation is **silently stripped** (option (a) from brainstorming). The claim stays, now read as unverified reasoning. The user never sees a misleading citation.

This gives the user two trust tiers readable at a glance:

- **Cited claim** → on the course slides, verified → trust blindly.
- **Uncited claim** → model's reasoning/computation → paste carefully, not course-verified.

## Behavior contract

1. Return only what the question asks for. No preamble, no restating the question, no explanation/justification unless the question explicitly asks for it, no sign-off.
2. Format follows the question: the model picks a computed number, a runnable SQL block, a bare or numbered list, or one line.
3. SQL goes in a single fenced ```sql block with no prose around it, so the user selects-and-pastes only the query. Theory answers are verbatim-ready text.
4. `(Folie N)` is allowed only when drawing that statement from that slide. Reasoned/computed answers carry no citation. Never cite a "related" slide.
5. Every emitted `(Folie N)` is verified: the page must exist and the claim must be supported by that slide's text. Unsupported citations are silently stripped; the claim stays as uncited.
6. If no slide covers the concept, the model answers from its own knowledge with no citation — fine, not a failure.

## Architecture

All changes stay server-side or in the existing browser controller. **No new dependencies, no embeddings, no vector store, no second LLM call.** The no-build-step, dependency-free-client architecture and the stealth UI are preserved. Keys never touch the browser (the citation check only reads slide text, no LLM).

The diff is small:

1. **One prompt rewrite in `serve.js`** (`CHAT_SYSTEM`) encoding the behavior contract.
2. **Slide-context assembly change in `assets/app.js`** (`runAsk`): top ~20 BM25 slides, each sent full-text (not 700-char truncated), with a one-line relevance note. Image asks still send only the image — unchanged.
3. **Client-side citation verify+strip in `assets/app.js`**: after the stream finishes, scan the final answer for `(Folie N)`, verify each against the in-memory `data.slides`, strip unsupported ones, re-render `streamBodyEl` once.

Routing (GLM for text, Haiku for image) and modality enforcement are unchanged.

## Data flow (one "Ask")

1. User types a complex question and hits Ctrl+Enter (or pastes a screenshot + Enter).
2. `app.js` runs BM25, takes the top ~20 slides, sends each full-text with a one-line relevance note as the slide-context block. Image asks send only the image.
3. `app.js` POSTs to `/q` with `{provider, messages}`. Text → GLM; image → Haiku.
4. Server calls GLM/Haiku with the new strict prompt. Tokens stream back and render live, exactly as today.
5. Stream ends; `app.js` does its existing final render of the raw answer.
6. `app.js` runs `verifyCitations(answer, data.slides)` locally: for each `(Folie N)`, check the page exists and the attached claim is supported by that slide's text (cheap local text match using the engine's existing fold/stem). Strip unsupported citations.
7. `app.js` rewrites `streamBodyEl` once with the verified answer. User sees cited (verified) and uncited (reasoning) claims; no misleading citations.

The verify step is best-effort and non-destructive: if it throws or slide text is missing for a page, it leaves that citation alone rather than risk a wrong strip. Prefer a missed strip over a false strip.

## Citation verifier (testable)

A pure function `verifyCitations(answerText, slides)` that returns the answer with unsupported citations stripped. Exposed for Node testing alongside the BM25 ranking checks (same file/UDM pattern as `search-engine.js`, or a function on `SlideSearchEngine`). Uses the engine's existing fold/stem for term matching against slide text.

Citation forms scanned: "(Folie N)", "(Folie S.N)", "(S. N)", "(slide N)" — folded the same way the existing markdown renderer detects slide refs. Anything unparseable is left as-is (no false strip).

## Edge cases & error handling

- Computed/SQL with no matching slide → no citations → passes through untouched (unverified reasoning, correct).
- Cited page doesn't exist (e.g. Folie 401 on a 317-slide set) → stripped.
- Real page, claim not supported → citation stripped, claim kept as uncited.
- Multiple citations on one claim ("(Folie 47, Folie 52)") → each checked independently; only unsupported stripped.
- Unparseable ref → left untouched.
- Verifier throws or slide text missing → citation left alone (no false strip).
- Image questions → no slides sent, no citations expected, verifier is a no-op. Image path unchanged.
- Streaming still works end-to-end: verify+strip is a single post-stream re-render of the existing `streamBodyEl`, same mechanism as the current final render — no extra flicker beyond the one rewrite that already happens.

## Testing & verification

New test for the citation verifier in `tests/engine.test.js`:

- Good citation (claim terms present on cited slide) → kept.
- Page doesn't exist → stripped.
- Real page, claim not supported → stripped.
- Multiple citations, mixed → only bad ones stripped.
- No citations → answer unchanged.
- Unparseable ref → left untouched.
- Verifier throws / missing slide text → citation left alone.

Exits non-zero on any failure — same regression gate as the BM25 ranking checks.

Manual smoke check after implementing: run `node serve.js`; ask a text question with a known slide-backed answer and a computed/SQL question; confirm just-answer format, real citations survive, a deliberately mis-cited claim gets its `(Folie N)` stripped, streaming still works, stealth UI and `:`-commands untouched. BM25 ranking tests stay green (the slide-context change is browser-side assembly, not an engine change).

## Out of scope

- Vector embeddings / semantic retrieval (Approach C from brainstorming — overkill; BM25 is already sub-ms and tuned for this German-DB content).
- A second LLM verification pass (doubles cost/latency; the local text-match check is sufficient for "is this citation supported").
- Any change to the stealth UI, `:`-commands, viewer, or search engine ranking.
- Practice testing / flashcards / progress tracking / syllabus overview (other brainstorming options the user did not choose).
