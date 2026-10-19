export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const PI_DEFAULT_THINKING_LEVEL = "medium";

export function normalizeThinkingLevel(level) {
  const s = String(level ?? "").trim().toLowerCase();
  return THINKING_LEVELS.includes(s) ? s : null;
}

export function mergePiSettings(global = {}, project = {}) {
  return {
    defaultThinkingLevel: project.defaultThinkingLevel ?? global.defaultThinkingLevel,
    modelThinkingLevels: { ...global.modelThinkingLevels, ...project.modelThinkingLevels },
  };
}

export function piDefaultThinkingLevel(settings, provider, modelId) {
  return (
    normalizeThinkingLevel(settings?.modelThinkingLevels?.[`${provider}/${modelId}`]) ||
    normalizeThinkingLevel(settings?.defaultThinkingLevel) ||
    PI_DEFAULT_THINKING_LEVEL
  );
}

export function turnThinkingLevel(requested, supportedLevels, fallback) {
  const level = normalizeThinkingLevel(requested);
  return level && Array.isArray(supportedLevels) && supportedLevels.includes(level)
    ? level
    : fallback;
}
