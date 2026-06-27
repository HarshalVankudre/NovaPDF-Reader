# OpenRouter GLM 5.2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all text-only tutor requests to OpenRouter GLM 5.2 with throughput-first provider selection, while automatically retaining Anthropic Haiku 4.5 for pasted-image questions.

**Architecture:** Add a small side-effect-free server configuration module for local env loading, provider definitions, modality routing, and OpenAI-compatible request-body construction. `serve.js` continues to own HTTP and streaming, while the browser exposes only GLM and selects Haiku automatically when image blocks are present; the server independently enforces the same modality rule.

**Tech Stack:** Node.js CommonJS, Node `http`/`fetch`, Anthropic SDK, plain browser JavaScript, OpenRouter OpenAI-compatible chat completions.

---

## File structure

- Create `llm-config.js`: parse local env files, construct the two-provider registry, detect image content, choose the enforced provider, and attach OpenRouter routing preferences.
- Create `tests/llm-config.test.js`: unit coverage for env precedence, key aliases, model configuration, throughput routing, and modality enforcement.
- Modify `serve.js`: consume `llm-config.js`, force `/llm` to GLM, enforce `/q` routing from message modality, and apply OpenRouter request preferences.
- Modify `assets/app.js`: make GLM the only selectable text provider and use Haiku only for pasted images.
- Modify `index.html`: reduce the hidden provider selector to GLM 5.2.
- Modify `tests/server.test.js`: explicitly verify `.env` and `.env.txt` cannot be served.
- Modify `serve.config.example.json`, `README.md`, `AGENTS.md`, and `CLAUDE.md`: document the two-route setup and supported key names.

### Task 1: Add tested env and provider configuration

**Files:**
- Create: `llm-config.js`
- Create: `tests/llm-config.test.js`

- [ ] **Step 1: Write failing configuration tests**

Create `tests/llm-config.test.js` with assertions equivalent to:

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseEnvText,
  loadLocalEnv,
  createLLMConfig,
  messagesContainImage,
  selectProviderForMessages,
  buildOpenAIRequestBody,
} = require("../llm-config");

const parsed = parseEnvText([
  "# ignored",
  "OPENROUTER_API_KEY=from-env",
  "QUOTED=\"quoted value\"",
  "export SINGLE='single value'",
].join("\n"));
assert.deepStrictEqual(parsed, {
  OPENROUTER_API_KEY: "from-env",
  QUOTED: "quoted value",
  SINGLE: "single value",
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-slide-env-"));
try {
  fs.writeFileSync(path.join(dir, ".env"), "OPENROUTER_API_KEY=canonical\n");
  fs.writeFileSync(path.join(dir, ".env.txt"), "OPEN_ROUTER_API_KEY=compat\nANTHROPIC_API_KEY=haiku\n");
  const target = { OPENROUTER_API_KEY: "process-wins" };
  loadLocalEnv(dir, target);
  assert.strictEqual(target.OPENROUTER_API_KEY, "process-wins");
  assert.strictEqual(target.OPEN_ROUTER_API_KEY, "compat");
  assert.strictEqual(target.ANTHROPIC_API_KEY, "haiku");

  const config = createLLMConfig(dir, { models: { glm: "custom/glm", haiku: "custom-haiku" } }, target);
  assert.strictEqual(config.keys.glm, "process-wins");
  assert.strictEqual(config.keys.haiku, "haiku");
  assert.strictEqual(config.providers.glm.model, "custom/glm");
  assert.strictEqual(config.providers.haiku.model, "custom-haiku");
  assert.deepStrictEqual(config.providers.glm.requestOptions, { provider: { sort: "throughput" } });
  const compatOnly = createLLMConfig(dir, {}, { OPEN_ROUTER_API_KEY: "compat-only" });
  assert.strictEqual(compatOnly.keys.glm, "compat-only");
  assert.strictEqual(compatOnly.providers.glm.model, "z-ai/glm-5.2");
  assert.strictEqual(compatOnly.providers.haiku.model, "claude-haiku-4-5");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const textMessages = [{ role: "user", content: [{ type: "text", text: "ACID?" }] }];
const imageMessages = [{ role: "user", content: [{ type: "image", data: "abc" }] }];
assert.strictEqual(messagesContainImage(textMessages), false);
assert.strictEqual(messagesContainImage(imageMessages), true);
assert.strictEqual(selectProviderForMessages(textMessages), "glm");
assert.strictEqual(selectProviderForMessages(imageMessages), "haiku");

const body = buildOpenAIRequestBody(
  { model: "z-ai/glm-5.2", requestOptions: { provider: { sort: "throughput" } } },
  { messages: [], stream: true }
);
assert.deepStrictEqual(body, {
  model: "z-ai/glm-5.2",
  messages: [],
  stream: true,
  provider: { sort: "throughput" },
});

console.log("llm configuration checks passed");
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tests/llm-config.test.js
```

Expected: FAIL with `Cannot find module '../llm-config'`.

- [ ] **Step 3: Implement the configuration module**

Create `llm-config.js` with these exported behaviors:

```js
const fs = require("fs");
const path = require("path");

function parseEnvText(text) {
  const values = {};
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadLocalEnv(root, target = process.env) {
  for (const name of [".env", ".env.txt"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnvText(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = value;
    }
  }
  return target;
}

function createLLMConfig(root, config = {}, env = process.env) {
  loadLocalEnv(root, env);
  const models = config.models || {};
  return {
    keys: {
      glm: env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY || config.openrouterApiKey || "",
      haiku: env.ANTHROPIC_API_KEY || config.anthropicApiKey || "",
    },
    providers: {
      glm: {
        label: "GLM 5.2",
        model: models.glm || "z-ai/glm-5.2",
        kind: "openai",
        url: "https://openrouter.ai/api/v1/chat/completions",
        envHint: "OPENROUTER_API_KEY or OPEN_ROUTER_API_KEY",
        requestOptions: { provider: { sort: "throughput" } },
      },
      haiku: {
        label: "Haiku 4.5",
        model: models.haiku || "claude-haiku-4-5",
        kind: "anthropic",
        envHint: "ANTHROPIC_API_KEY",
      },
    },
  };
}

function messagesContainImage(messages) {
  return Array.isArray(messages) && messages.some((message) =>
    Array.isArray(message && message.content) &&
    message.content.some((block) => block && block.type === "image")
  );
}

function selectProviderForMessages(messages) {
  return messagesContainImage(messages) ? "haiku" : "glm";
}

function buildOpenAIRequestBody(provider, fields) {
  return Object.assign({ model: provider.model }, fields, provider.requestOptions || {});
}

module.exports = {
  parseEnvText,
  loadLocalEnv,
  createLLMConfig,
  messagesContainImage,
  selectProviderForMessages,
  buildOpenAIRequestBody,
};
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```powershell
node tests/llm-config.test.js
```

Expected: `llm configuration checks passed`.

- [ ] **Step 5: Commit**

```powershell
git add llm-config.js tests/llm-config.test.js
git commit -m "Add GLM and Haiku provider configuration"
```

### Task 2: Route server requests by modality

**Files:**
- Modify: `serve.js:5-7`
- Modify: `serve.js:110-136`
- Modify: `serve.js:184-202`
- Modify: `serve.js:207-220`
- Modify: `serve.js:274-321`
- Modify: `serve.js:347-381`
- Modify: `serve.js:433-439`
- Modify: `tests/llm-config.test.js`

- [ ] **Step 1: Confirm the provider contract was established test-first**

The failing tests from Task 1 already define the server behaviors used here:

```text
- text message blocks select glm
- image message blocks select haiku
- OpenRouter request bodies contain provider.sort=throughput
```

Do not add an alternate routing path in `serve.js`; it must consume these tested helpers directly.

- [ ] **Step 2: Wire `serve.js` to the tested provider module**

Import the module and replace the four-provider registry:

```js
const {
  createLLMConfig,
  selectProviderForMessages,
  buildOpenAIRequestBody,
} = require("./llm-config");

const CONFIG = loadConfig();
const LLM = createLLMConfig(ROOT, CONFIG);
const KEYS = LLM.keys;
const PROVIDERS = LLM.providers;
```

Build both OpenAI-compatible request bodies through the helper:

```js
body: JSON.stringify(buildOpenAIRequestBody(p, {
  messages: [{ role: "system", content: system }, { role: "user", content: user }],
  max_tokens: 1024,
  temperature: 0.2,
  response_format: { type: "json_object" },
})),
```

```js
body: JSON.stringify(buildOpenAIRequestBody(p, {
  messages: [{ role: "system", content: CHAT_SYSTEM }].concat(toOpenAIMessages(messages)),
  max_tokens: 2048,
  temperature: 0.3,
  stream: true,
})),
```

Make the legacy single-shot path always use GLM:

```js
async function askLLM(question, candidates) {
  const p = PROVIDERS.glm;
  const key = KEYS.glm;
  // existing prompt, timing, parsing, and error behavior
}
```

Enforce streaming selection from content:

```js
async function streamChat(messages, res) {
  const provider = selectProviderForMessages(messages);
  const p = PROVIDERS[provider];
  const key = KEYS[provider];
  // existing missing-key and kind dispatch behavior
}
```

In `/q`, compute `provider` with `selectProviderForMessages(messages)` before key validation and ignore the browser’s requested provider for routing. Update startup logging to:

```js
console.log("LLM keys present: glm=" + !!KEYS.glm + " haiku=" + !!KEYS.haiku);
```

- [ ] **Step 3: Run focused tests**

Run:

```powershell
node tests/llm-config.test.js
node tests/server.test.js
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```powershell
git add serve.js tests/llm-config.test.js
git commit -m "Route tutor requests through GLM and Haiku"
```

### Task 3: Make GLM the only visible text provider

**Files:**
- Modify: `index.html:50-56`
- Modify: `assets/app.js:10-15`
- Modify: `assets/app.js:68-79`
- Modify: `assets/app.js:494-505`
- Modify: `assets/app.js:681-692`
- Modify: `assets/app.js:719`

- [ ] **Step 1: Capture the expected client contract**

Before editing, record these manual assertions for browser verification:

```text
1. The hidden provider selector has exactly one option: GLM 5.2.
2. A normal text ask sends provider "glm" and no slide image blocks.
3. A pasted-image ask sends provider "haiku".
4. :glm, :haiku, :claude, :codex, :sonnet, :grok, and :deepseek leave GLM selected for text.
```

- [ ] **Step 2: Update the selector and client constants**

Change `index.html` to:

```html
<select id="aiProvider" class="ai-provider" title="Choose the AI model" aria-label="AI model">
  <option value="glm">GLM 5.2</option>
</select>
```

Change the provider constants and normalization in `assets/app.js` to:

```js
const DEFAULT_PROVIDER = "glm";
const AI_PROVIDERS = ["glm"];
const PROVIDER_ALIASES = {
  haiku: "glm",
  claude: "glm",
  codex: "glm",
  sonnet: "glm",
  grok: "glm",
  deepseek: "glm",
};
```

Remove `VISION_PROVIDERS` and `providerCanUseVision`.

- [ ] **Step 3: Route browser requests by image presence**

In `runAsk`, replace provider and slide-image selection with:

```js
const provider = isImageAsk ? "haiku" : "glm";
```

For text requests, keep BM25 slide text but set:

```js
topPages = [];
```

This prevents rendered slide PNGs from being sent to text-only GLM. Keep pasted screenshots in the existing image blocks.

Update the secret-command comment to list `:glm` and compatibility aliases. Commands normalized through `PROVIDER_ALIASES` continue to select GLM.

- [ ] **Step 4: Run syntax and regression checks**

Run:

```powershell
node --check assets/app.js
node --check serve.js
node tests/llm-config.test.js
node tests/server.test.js
node tests/engine.test.js
```

Expected: syntax checks exit 0 and all three test scripts pass.

- [ ] **Step 5: Commit**

```powershell
git add index.html assets/app.js
git commit -m "Use GLM for text and Haiku for images"
```

### Task 4: Lock down secret-file and configuration documentation

**Files:**
- Modify: `tests/server.test.js:35-48`
- Modify: `serve.config.example.json`
- Modify: `README.md:36-69`
- Modify: `AGENTS.md:23-58`
- Modify: `CLAUDE.md:23-58`

- [ ] **Step 1: Add secret-file regression assertions**

Add after the existing `serve.config.json` assertion:

```js
const envFile = await request("/.env");
assert.strictEqual(envFile.status, 403, ".env must not be exposed");

const envTextFile = await request("/.env.txt");
assert.strictEqual(envTextFile.status, 403, ".env.txt must not be exposed");
```

These are characterization checks for the generic dotfile block and should pass without production changes.

- [ ] **Step 2: Update the example config**

Replace `serve.config.example.json` with:

```json
{
  "_comment": "Copy this file to serve.config.json and fill in the keys you have. Prefer OPENROUTER_API_KEY and ANTHROPIC_API_KEY environment variables, or local .env/.env.txt entries. Restart after changing keys.",
  "openrouterApiKey": "sk-or-...",
  "anthropicApiKey": "sk-ant-...",
  "models": {
    "glm": "z-ai/glm-5.2",
    "haiku": "claude-haiku-4-5"
  }
}
```

- [ ] **Step 3: Update repository documentation**

Document these exact operational rules in `README.md`, `AGENTS.md`, and `CLAUDE.md`:

```text
- OPENROUTER_API_KEY is canonical; OPEN_ROUTER_API_KEY remains accepted.
- .env and .env.txt are loaded locally at startup.
- Text questions use OpenRouter z-ai/glm-5.2 with throughput sorting.
- Pasted images automatically use Anthropic claude-haiku-4-5.
- :glm is the active provider command; legacy provider commands normalize to GLM.
- Provider changes must keep llm-config.js, index.html, and assets/app.js synchronized.
```

Also correct the architecture description: slide PNGs are no longer sent for ordinary text RAG; only pasted screenshots use the vision route.

- [ ] **Step 4: Run documentation and server checks**

Run:

```powershell
node tests/server.test.js
git diff --check
rg -n "XAI_API_KEY|DEEPSEEK_API_KEY|Sonnet 4.6|Grok 4.3|DeepSeek V4" README.md AGENTS.md CLAUDE.md serve.config.example.json index.html assets/app.js serve.js
```

Expected: server checks pass, `git diff --check` is clean, and `rg` returns no obsolete provider references in the listed files.

- [ ] **Step 5: Commit**

```powershell
git add tests/server.test.js serve.config.example.json README.md AGENTS.md CLAUDE.md
git commit -m "Document OpenRouter GLM configuration"
```

### Task 5: Verify browser behavior and live OpenRouter streaming

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run the full automated regression gate**

Run:

```powershell
node tests/llm-config.test.js
node tests/server.test.js
node tests/engine.test.js
node --check serve.js
node --check assets/app.js
git diff --check
```

Expected: every command exits 0; the engine suite reports all ranking checks passed.

- [ ] **Step 2: Start the bundled server**

Run `node serve.js` as a hidden background process and wait for:

```text
DB Slide Finder  ->  http://localhost:8000
LLM keys present: glm=true
```

Do not print env-file contents or key values.

- [ ] **Step 3: Verify the browser contract**

Open `http://localhost:8000`, reveal the hidden controls with `:ai`, and verify:

```text
- one provider option labeled GLM 5.2
- no console errors
- text search and slide navigation still work
- legacy :haiku command leaves GLM selected
```

- [ ] **Step 4: Run a live text smoke test through `/q`**

POST a minimal text-only message:

```json
{
  "provider": "glm",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Antworte nur mit: OK"
        }
      ]
    }
  ]
}
```

Expected: HTTP 200 with a non-empty streamed response from GLM 5.2. If OpenRouter rejects a generation parameter, capture the response, add a failing compatibility test, and make only the minimal request-body adjustment required.

- [ ] **Step 5: Review final repository state**

Run:

```powershell
git status --short
git log -6 --oneline
```

Expected: only intentional changes exist and all implementation commits are present.
