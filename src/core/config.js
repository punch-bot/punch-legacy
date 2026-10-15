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

// Bot owners as comma-separated Discord user IDs (e.g. "1234567890,0987654321").
// Only owners may run owner-scoped commands like /sandbox restart-all.
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
  { label: "Claude Sonnet 4", value: "anthropic/claude-sonnet-4-20250514", emoji: "🧠" },
  { label: "Claude 3.5 Sonnet", value: "anthropic/claude-3.5-sonnet-20241022", emoji: "🧠" },
  { label: "Claude 3.7 Sonnet", value: "anthropic/claude-3.7-sonnet-20250219", emoji: "🧠" },
  { label: "Claude Opus 4", value: "anthropic/claude-opus-4-20250514", emoji: "⭐" },
  { label: "GPT-4o", value: "openai/gpt-4o", emoji: "🤖" },
  { label: "GPT-4o-mini", value: "openai/gpt-4o-mini", emoji: "🤖" },
  { label: "o3-mini", value: "openai/o3-mini", emoji: "🤖" },
  { label: "Gemini 2.5 Pro", value: "google/gemini-2.5-pro-preview-05-06", emoji: "🔮" },
  { label: "Gemini 2.0 Flash", value: "google/gemini-2.0-flash-001", emoji: "🔮" },
  { label: "DeepSeek Chat", value: "deepseek/deepseek-chat", emoji: "🌊" },
  { label: "Claude 3 Haiku", value: "anthropic/claude-3-haiku-20240307", emoji: "⚡" },
  { label: "Claude Sonnet 4.5 (default)", value: "anthropic/claude-sonnet-4-5", emoji: "🧠" },
  { label: "Poolside Laguna Medium", value: "poolside/poolside/laguna-m.1", emoji: "🏊" },
  { label: "Poolside Laguna XS", value: "poolside/poolside/laguna-xs-2.1", emoji: "🏊" },
  { label: "NIM GLM-5.2 (z-ai)", value: "nvidia/z-ai/glm-5.2", emoji: "💚" },
  { label: "NIM Nemotron 70B", value: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct", emoji: "💚" },
  { label: "Custom model...", value: "__custom__", emoji: "✏️" },
];

// /models reasoning dropdown. "default" clears the override; the rest must
// match THINKING_LEVELS in docker/sandbox/usr/local/lib/pi-thinking-level.mjs.
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
