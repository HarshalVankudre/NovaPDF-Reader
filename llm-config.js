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
  const anthropicKey = env.ANTHROPIC_API_KEY || config.anthropicApiKey || "";
  return {
    keys: {
      glm: env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY || config.openrouterApiKey || "",
      sonnet: anthropicKey,
      haiku: anthropicKey,
    },
    providers: {
      glm: {
        label: "GLM 5.2",
        model: models.glm || "z-ai/glm-5.2",
        kind: "openai",
        url: "https://openrouter.ai/api/v1/chat/completions",
        envHint: "OPENROUTER_API_KEY or OPEN_ROUTER_API_KEY",
        requestOptions: { provider: { sort: "throughput" } },
        vision: false,
      },
      sonnet: {
        label: "Claude Sonnet 4.6",
        model: models.sonnet || "claude-sonnet-4-6",
        kind: "anthropic",
        envHint: "ANTHROPIC_API_KEY",
        vision: true,
      },
      haiku: {
        label: "Haiku 4.5",
        model: models.haiku || "claude-haiku-4-5",
        kind: "anthropic",
        envHint: "ANTHROPIC_API_KEY",
        vision: true,
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
  return messagesContainImage(messages) ? "sonnet" : "glm";
}

// Ordered list of providers to try for a request. Images must go to a vision
// model (modality enforcement), and quality matters most for exam diagrams, so
// vision tries Sonnet then Haiku. Text-only tries the user's preferred provider
// first (if valid), then GLM (fast) -> Claude as resilient fallbacks. The chain
// is what makes a single API outage non-fatal on exam day.
function providerChainForMessages(messages, preferred) {
  if (messagesContainImage(messages)) return ["sonnet", "haiku"];
  const base = ["glm", "sonnet", "haiku"];
  const pref = String(preferred || "").trim().toLowerCase();
  if (base.indexOf(pref) !== -1) return [pref].concat(base.filter((p) => p !== pref));
  return base;
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
