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
      opus: env.ANTHROPIC_API_KEY || config.anthropicApiKey || "",
    },
    providers: {
      // Provider id stays "opus" (client AI_PROVIDER + models.opus override key)
      // even though the model is now Claude Fable 5 — renaming the id would
      // ripple through the client, tests, and existing serve.config.json files.
      opus: {
        label: "Claude Fable 5",
        model: models.opus || "claude-fable-5",
        kind: "anthropic",
        envHint: "ANTHROPIC_API_KEY",
        vision: true, // Fable 5 is multimodal with high-res vision (2576px) — reads dense ER diagrams
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

// The single provider (id "opus", model Claude Fable 5) is multimodal, so it
// serves every request — text questions and pasted screenshots alike.
function selectProviderForMessages() {
  return "opus";
}

// Single-provider setup: every request resolves to Opus (text and images).
// There is no cross-provider outage fallback — streamAnthropic() runs the SDK's
// own request, and the OpenAI path keeps a transient-error retry for any future
// provider. Signature kept (messages, preferred) for call-site/test compatibility.
function providerChainForMessages() {
  return ["opus"];
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
  providerChainForMessages,
  buildOpenAIRequestBody,
};
