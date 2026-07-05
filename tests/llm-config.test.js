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
  providerChainForMessages,
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
const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-slide-clean-env-"));
try {
  fs.writeFileSync(path.join(dir, ".env"), "OPENROUTER_API_KEY=canonical\n");
  fs.writeFileSync(path.join(dir, ".env.txt"), "OPEN_ROUTER_API_KEY=compat\nANTHROPIC_API_KEY=ak-test\n");

  const target = { OPENROUTER_API_KEY: "process-wins" };
  loadLocalEnv(dir, target);
  assert.strictEqual(target.OPENROUTER_API_KEY, "process-wins");
  assert.strictEqual(target.OPEN_ROUTER_API_KEY, "compat");
  assert.strictEqual(target.ANTHROPIC_API_KEY, "ak-test");

  const config = createLLMConfig(dir, { models: { opus: "custom-opus" } }, target);
  assert.strictEqual(config.keys.opus, "ak-test", "ANTHROPIC_API_KEY powers Opus");
  assert.deepStrictEqual(Object.keys(config.providers), ["opus"], "Opus is the only provider");
  assert.strictEqual(config.providers.opus.model, "custom-opus");
  assert.strictEqual(config.providers.opus.kind, "anthropic");
  assert.strictEqual(config.providers.opus.vision, true, "Opus handles vision too");

  const compatOnly = createLLMConfig(cleanDir, {}, { ANTHROPIC_API_KEY: "anthropic-only" });
  assert.strictEqual(compatOnly.keys.opus, "anthropic-only");
  assert.strictEqual(compatOnly.providers.opus.model, "claude-opus-4-8");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cleanDir, { recursive: true, force: true });
}

const textMessages = [{ role: "user", content: [{ type: "text", text: "ACID?" }] }];
const imageMessages = [{ role: "user", content: [{ type: "image", data: "abc" }] }];
assert.strictEqual(messagesContainImage(textMessages), false);
assert.strictEqual(messagesContainImage(imageMessages), true);
assert.strictEqual(selectProviderForMessages(textMessages), "opus");
assert.strictEqual(selectProviderForMessages(imageMessages), "opus", "Opus serves vision too");

// single-provider setup: every request resolves to Opus (text and images alike)
assert.deepStrictEqual(providerChainForMessages(imageMessages), ["opus"]);
assert.deepStrictEqual(providerChainForMessages(textMessages), ["opus"]);
assert.deepStrictEqual(providerChainForMessages(textMessages, "bogus"), ["opus"], "preference no longer changes the single-provider chain");

// buildOpenAIRequestBody is a generic util (kept for any OpenAI-compatible provider)
const body = buildOpenAIRequestBody(
  { model: "test/model", requestOptions: { provider: { sort: "throughput" } } },
  { messages: [], stream: true }
);
assert.deepStrictEqual(body, {
  model: "test/model",
  messages: [],
  stream: true,
  provider: { sort: "throughput" },
});

console.log("llm configuration checks passed");
