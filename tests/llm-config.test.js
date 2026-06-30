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

  const config = createLLMConfig(dir, { models: { sonnet: "custom-sonnet" } }, target);
  assert.strictEqual(config.keys.sonnet, "ak-test", "ANTHROPIC_API_KEY powers Sonnet");
  assert.deepStrictEqual(Object.keys(config.providers), ["sonnet"], "Sonnet is the only provider");
  assert.strictEqual(config.providers.sonnet.model, "custom-sonnet");
  assert.strictEqual(config.providers.sonnet.kind, "anthropic");
  assert.strictEqual(config.providers.sonnet.vision, true, "Sonnet handles vision too");

  const compatOnly = createLLMConfig(cleanDir, {}, { ANTHROPIC_API_KEY: "anthropic-only" });
  assert.strictEqual(compatOnly.keys.sonnet, "anthropic-only");
  assert.strictEqual(compatOnly.providers.sonnet.model, "claude-sonnet-5");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cleanDir, { recursive: true, force: true });
}

const textMessages = [{ role: "user", content: [{ type: "text", text: "ACID?" }] }];
const imageMessages = [{ role: "user", content: [{ type: "image", data: "abc" }] }];
assert.strictEqual(messagesContainImage(textMessages), false);
assert.strictEqual(messagesContainImage(imageMessages), true);
assert.strictEqual(selectProviderForMessages(textMessages), "sonnet");
assert.strictEqual(selectProviderForMessages(imageMessages), "sonnet", "Sonnet serves vision too");

// single-provider setup: every request resolves to Sonnet (text and images alike)
assert.deepStrictEqual(providerChainForMessages(imageMessages), ["sonnet"]);
assert.deepStrictEqual(providerChainForMessages(textMessages), ["sonnet"]);
assert.deepStrictEqual(providerChainForMessages(textMessages, "bogus"), ["sonnet"], "preference no longer changes the single-provider chain");

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
