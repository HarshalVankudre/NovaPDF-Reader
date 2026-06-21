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
