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
      sonnet: env.ANTHROPIC_API_KEY || config.anthropicApiKey || "",
    },
    providers: {
      sonnet: {
        label: "Claude Sonnet 5",
        model: models.sonnet || "claude-sonnet-5",
        kind: "anthropic",
        envHint: "ANTHROPIC_API_KEY",
        vision: true, // Sonnet 5 is multimodal with high-res vision — reads dense ER diagrams
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

// Sonnet is the only provider and is multimodal, so it serves every request —
// text questions and pasted screenshots alike.
function selectProviderForMessages() {
  return "sonnet";
}

// Single-provider setup: every request resolves to Sonnet (text and images).
// There is no cross-provider outage fallback — streamAnthropic() runs the SDK's
// own request, and the OpenAI path keeps a transient-error retry for any future
// provider. Signature kept (messages, preferred) for call-site/test compatibility.
function providerChainForMessages() {
  return ["sonnet"];
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
