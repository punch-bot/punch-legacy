export const TOKEN = process.env.DISCORD_TOKEN;
export const PREFIX = process.env.PREFIX || "!";
export const DOCTOR_REPAIR_TTL_MS = 10 * 60_000;
export const REACTION_DEDUP_MS = 5000;
export const THREAD_WINDOW = 100;
export const RESIDUE_LIMIT = 10;
export const MAX_UPLOAD = Number(process.env.DISCORD_MAX_UPLOAD) || 8 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = (Number(process.env.PI_MAX_ATTACHMENT) || 10) * 1024 * 1024;
export const COMPRESS_TIMEOUT_MS = Number(process.env.PI_COMPRESS_TIMEOUT) || 300;
export const BOT_HTTP_PORT = 4098;

export const BOT_OWNERS = new Set(
  (process.env.BOT_OWNERS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

export function isBotOwner(userId) {
  return userId != null && BOT_OWNERS.has(String(userId));
}

export const MODEL_LIST = [
  { label: "Big Pickle (default)", value: "opencode/big-pickle", emoji: "🥒" },
  { label: "Claude Fable 5.1", value: "anthropic/claude-fable-5-1", emoji: "⭐" },
  { label: "Claude Opus 5.5", value: "anthropic/claude-opus-5-5", emoji: "⭐" },
  { label: "Claude Sonnet 5.5", value: "anthropic/claude-sonnet-5-5", emoji: "🧠" },
  { label: "Claude Haiku 5.5", value: "anthropic/claude-haiku-5-5", emoji: "⚡" },
  { label: "GPT-6.1 Sol", value: "openai/gpt-6.1-sol", emoji: "🤖" },
  { label: "GPT-6 Luna", value: "openai/gpt-6-luna", emoji: "🤖" },
  { label: "GPT-5.4 mini", value: "openai/gpt-5.4-mini", emoji: "🤖" },
  { label: "ChatGPT GPT-6.1 Sol (/chatgpt signin)", value: "openai-codex/gpt-6.1-sol", emoji: "💬" },
  { label: "Gemini 4 Argon", value: "google/gemini-4-argon", emoji: "🔮" },
  { label: "Gemini 3.8 Flash", value: "google/gemini-3.8-flash", emoji: "🔮" },
  { label: "DeepSeek V4 Pro", value: "deepseek/deepseek-v4-pro", emoji: "🌊" },
  { label: "DeepSeek V4.1 Flash", value: "deepseek/deepseek-flash", emoji: "🌊" },
  { label: "Kimi K3 (Zen)", value: "opencode/kimi-k3", emoji: "🌙" },
  { label: "GLM-5.3 (Zen)", value: "opencode/glm-5.3", emoji: "🧩" },
  { label: "Poolside Laguna Medium", value: "poolside/poolside/laguna-m.1", emoji: "🏊" },
  { label: "Poolside Laguna XS", value: "poolside/poolside/laguna-xs-2.1", emoji: "🏊" },
  { label: "NIM GLM-5.3 (z-ai)", value: "nvidia/z-ai/glm-5.3", emoji: "💚" },
  { label: "NIM Nemotron 3 Ultra", value: "nvidia/nvidia/nemotron-3-ultra-550b-a55b", emoji: "💚" },
  { label: "Custom model...", value: "__custom__", emoji: "✏️" },
];

export const THINKING_LEVEL_LIST = [
  { label: "Default", value: "default", description: "Whatever the model uses on its own" },
  { label: "Off", value: "off", description: "No reasoning" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high", value: "xhigh", description: "Only some models" },
  { label: "Max", value: "max", description: "Only some models" },
];

export const PROVIDER_NAMES = ["anthropic", "openai", "openrouter", "google", "deepseek", "groq", "together", "poolside", "opencode", "opencode-go", "nvidia"];

export function supervisorAuth() {
  return "Basic " + Buffer.from(`${process.env.PI_SERVER_USERNAME || "pi"}:${process.env.PI_SERVER_PASSWORD || ""}`).toString("base64");
}
