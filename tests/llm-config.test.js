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
  fs.writeFileSync(path.join(dir, ".env.txt"), "OPEN_ROUTER_API_KEY=compat\nANTHROPIC_API_KEY=haiku\n");

  const target = { OPENROUTER_API_KEY: "process-wins" };
  loadLocalEnv(dir, target);
  assert.strictEqual(target.OPENROUTER_API_KEY, "process-wins");
  assert.strictEqual(target.OPEN_ROUTER_API_KEY, "compat");
  assert.strictEqual(target.ANTHROPIC_API_KEY, "haiku");

  const config = createLLMConfig(dir, { models: { glm: "custom/glm", haiku: "custom-haiku", sonnet: "custom-sonnet" } }, target);
  assert.strictEqual(config.keys.glm, "process-wins");
  assert.strictEqual(config.keys.haiku, "haiku");
  assert.strictEqual(config.keys.sonnet, "haiku", "sonnet shares the Anthropic key");
  assert.strictEqual(config.providers.glm.model, "custom/glm");
  assert.strictEqual(config.providers.haiku.model, "custom-haiku");
  assert.strictEqual(config.providers.sonnet.model, "custom-sonnet");
  assert.deepStrictEqual(config.providers.glm.requestOptions, { provider: { sort: "throughput" } });

  const compatOnly = createLLMConfig(cleanDir, {}, { OPEN_ROUTER_API_KEY: "compat-only" });
  assert.strictEqual(compatOnly.keys.glm, "compat-only");
  assert.strictEqual(compatOnly.providers.glm.model, "z-ai/glm-5.2");
  assert.strictEqual(compatOnly.providers.haiku.model, "claude-haiku-4-5");
  assert.strictEqual(compatOnly.providers.sonnet.model, "claude-sonnet-4-6");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cleanDir, { recursive: true, force: true });
}

const textMessages = [{ role: "user", content: [{ type: "text", text: "ACID?" }] }];
const imageMessages = [{ role: "user", content: [{ type: "image", data: "abc" }] }];
assert.strictEqual(messagesContainImage(textMessages), false);
assert.strictEqual(messagesContainImage(imageMessages), true);
assert.strictEqual(selectProviderForMessages(textMessages), "glm");
assert.strictEqual(selectProviderForMessages(imageMessages), "sonnet");

// fallback chains: images go to vision models only; text honors a valid preference first
assert.deepStrictEqual(providerChainForMessages(imageMessages), ["sonnet", "haiku"]);
assert.deepStrictEqual(providerChainForMessages(imageMessages, "glm"), ["sonnet", "haiku"], "images never fall back to a text-only model");
assert.deepStrictEqual(providerChainForMessages(textMessages), ["glm", "sonnet", "haiku"]);
assert.deepStrictEqual(providerChainForMessages(textMessages, "sonnet"), ["sonnet", "glm", "haiku"]);
assert.deepStrictEqual(providerChainForMessages(textMessages, "bogus"), ["glm", "sonnet", "haiku"], "unknown preference is ignored");

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
