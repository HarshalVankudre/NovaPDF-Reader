# OpenRouter GLM 5.2 Migration

## Goal

Use OpenRouter-hosted GLM 5.2 for every text-only tutor request while retaining Anthropic Haiku 4.5 exclusively for pasted-image questions. Preserve the existing stealth PDF-viewer interface, RAG behavior, streaming responses, and server-side key isolation.

## Provider behavior

- Text-only questions use OpenRouter model `z-ai/glm-5.2`.
- OpenRouter requests include `provider: { "sort": "throughput" }`. OpenRouter dynamically prioritizes the endpoint with the highest measured output throughput and retains provider fallback behavior. This is preferred over pinning a single infrastructure provider because endpoint performance and availability change over time.
- Pasted-image questions use Anthropic model `claude-haiku-4-5`.
- GLM 5.2 receives slide text from BM25 retrieval but no rendered slide images because the model is text-only.
- Haiku receives the pasted image as the self-contained question, matching the current image-question flow.
- The browser requests the appropriate route from whether a pasted image is present. The server also inspects streaming message content and enforces Haiku for image blocks and GLM for text-only content, so stale clients cannot send an unsupported modality to either model.
- The legacy single-shot `/llm` route is text-only and always uses GLM.

## Configuration

The server loads secrets from process environment variables first, then local environment files, then `serve.config.json`.

Supported OpenRouter key names:

1. `OPENROUTER_API_KEY` — canonical name.
2. `OPEN_ROUTER_API_KEY` — compatibility with the key already present in `.env.txt`.
3. `openrouterApiKey` in `serve.config.json`.

Supported Anthropic key names remain:

1. `ANTHROPIC_API_KEY`.
2. `anthropicApiKey` in `serve.config.json`.

The server loads simple `KEY=VALUE` entries from `.env` and `.env.txt` without overwriting environment variables already supplied by the launching process. This is implemented locally without adding a runtime dependency. Both files remain blocked from static serving by the existing dotfile/config guardrails and gitignored patterns.

Runtime model overrides remain available under `models`:

```json
{
  "models": {
    "glm": "z-ai/glm-5.2",
    "haiku": "claude-haiku-4-5"
  }
}
```

## Interface changes

- The visible provider selector contains only `GLM 5.2`.
- GLM is the default and persisted text provider.
- Image requests silently route to Haiku without changing the visible selector.
- Typed `:glm` selects the text provider.
- Existing `:haiku`, `:claude`, and `:codex` commands remain accepted for compatibility, but they cannot force text requests away from GLM. When an image is attached, routing uses Haiku automatically regardless of the visible selection.
- Obsolete Sonnet, Grok, and DeepSeek choices and commands are removed.
- No AI branding or provider-routing explanation is added to the visible interface.

## Request format

OpenRouter uses the OpenAI-compatible endpoint:

`https://openrouter.ai/api/v1/chat/completions`

Both single-shot and streaming requests include:

```json
{
  "model": "z-ai/glm-5.2",
  "provider": {
    "sort": "throughput"
  }
}
```

The existing temperature, token limits, JSON response mode, and SSE parsing remain unchanged unless GLM compatibility requires a narrowly scoped adjustment discovered by a failing test or API smoke test.

Optional OpenRouter attribution headers are omitted because the application is local and deliberately disguised.

## Error handling

- Missing OpenRouter credentials report the accepted environment-variable names and require a server restart.
- Missing Anthropic credentials affect pasted-image questions only.
- OpenRouter HTTP failures continue to be normalized into the existing proxy error behavior without exposing keys.
- Invalid or unsupported browser provider values normalize to GLM for text requests.
- The startup log reports only whether each required key is present, never its value.

## Testing

Automated regression coverage will verify:

- `.env.txt` and `.env` parsing without overriding process environment values.
- Both OpenRouter environment-variable spellings are accepted.
- Text requests select `z-ai/glm-5.2`.
- OpenRouter request bodies include throughput sorting.
- Image requests select Haiku 4.5.
- Server-side modality enforcement overrides stale or manipulated provider values.
- Legacy text provider names normalize to GLM rather than restoring removed providers.
- Static requests cannot expose `.env`, `.env.txt`, or `serve.config.json`.
- Existing search-engine and server regression suites still pass.

A live smoke test will start the bundled Node server and issue one short text request when a usable OpenRouter key is available. It will not print or persist the key. Haiku image routing will be validated structurally unless an Anthropic key is available.

## Non-goals

- Replacing BM25 retrieval.
- Sending slide images to GLM 5.2.
- Adding more OpenRouter models or a user-facing router menu.
- Pinning a specific OpenRouter infrastructure provider.
- Changing the viewer, search ranking, tutor prompt, or stealth presentation.

## References

- OpenRouter GLM 5.2 model ID: <https://openrouter.ai/z-ai/glm-5.2>
- OpenRouter provider sorting: <https://openrouter.ai/docs/guides/routing/provider-selection>
