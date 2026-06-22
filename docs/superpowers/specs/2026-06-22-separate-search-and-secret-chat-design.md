# Separate Search and Secret Chat

## Goal

Keep the visible BM25 slide search unchanged while making the hidden tutor behave like normal chat. The tutor must not automatically receive search results, extracted slide text, rendered slide images, or slide metadata.

## User-visible behavior

- Typing a normal query continues to run BM25 and show ranked slide results in the search interface.
- Invoking the hidden tutor sends only the user's typed question.
- If the user pasted one or more screenshots, the tutor sends the typed question and those screenshots.
- A screenshot remains a self-contained question; no slide context is attached.
- Existing stealth behavior, keyboard commands, PDF viewing, and BM25 ranking remain unchanged.

## Request data flow

For a text-only tutor request:

```text
typed question -> POST /q -> model
```

For a screenshot tutor request:

```text
typed question + pasted screenshots -> POST /q -> model
```

The tutor request must not contain:

- BM25 result excerpts
- slide titles or lecture metadata
- rendered slide images
- generated `Folie N` context markers

BM25 may still run independently to update the visible search results as the user types. Its output is not reused by the tutor.

## Prompt behavior

The tutor system prompt should answer the question directly in the same language as the user. It should retain the existing concise/structured response rules and stealth restrictions, but remove requirements to:

- answer only from provided slides
- cite slides as `(Folie N)`
- report that the slides lack an answer

Screenshot instructions should continue requesting a complete, structured solution when appropriate.

## Model boundary

This change separates context behavior from model selection. The implementation may configure a faster multimodal model separately, but the request contract remains provider-neutral: text plus optional images.

## Error handling

Existing request validation, streaming error handling, and UI error rendering remain unchanged. Empty requests without text or screenshots are still ignored.

## Testing

Add a regression test around the tutor payload builder or equivalent testable unit proving:

1. A text-only question produces a payload containing only that question.
2. A screenshot question contains the question and screenshot blocks.
3. Neither request contains slide excerpts, slide images, slide titles, lecture metadata, or `Folie` markers.

Run the existing search-engine and server test suites to verify that visible BM25 search and server behavior remain intact.

## Out of scope

- Removing or changing BM25 search
- Changing search ranking
- Adding an explicit “search the slides” tutor mode
- Reintroducing main-view text highlighting
- Changing the stealth UI or exposing AI branding
