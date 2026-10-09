// Per-turn reasoning (thinking) level for Pi.
//
// The user picks one level, stored by the supervisor beside the model, and the
// gateway applies it to whichever model a turn runs on. Pi's
// set_thinking_level clamps an unsupported level to the nearest supported one;
// Punch uses Pi's default for that model instead, so the gateway checks the
// model's levels first. The level is never encoded as a `--model x/y:high`
// suffix.

/** Pi's levels, lowest to highest. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Pi's built-in default when its settings name none (core/defaults.js). */
export const PI_DEFAULT_THINKING_LEVEL = "medium";

/** A Pi level, or null meaning "use the default" (unset, "default", unknown). */
export function normalizeThinkingLevel(level) {
  const s = String(level ?? "").trim().toLowerCase();
  return THINKING_LEVELS.includes(s) ? s : null;
}

/**
 * Pi settings.json with the default level stated, or null when it already
 * names a valid one. With a stated default, set_model resets to it rather
 * than keeping the previous turn's level. Exact match: Pi doesn't normalize,
 * and would turn "High" into "off".
 */
export function withDefaultThinkingLevel(settings) {
  if (THINKING_LEVELS.includes(settings?.defaultThinkingLevel)) return null;
  return { ...settings, defaultThinkingLevel: PI_DEFAULT_THINKING_LEVEL };
}

/** Pi's merge of global and project settings.json, for the keys read here. */
export function mergePiSettings(global = {}, project = {}) {
  return {
    defaultThinkingLevel: project.defaultThinkingLevel ?? global.defaultThinkingLevel,
    modelThinkingLevels: { ...global.modelThinkingLevels, ...project.modelThinkingLevels },
  };
}

/**
 * Pi's default level for a model, picked like set_model does but without
 * carrying over the session's previous level: per-model setting, then global
 * default, then "medium". Pi clamps it to the model when it is applied, as it
 * does for its own defaults.
 */
export function piDefaultThinkingLevel(settings, provider, modelId) {
  return (
    normalizeThinkingLevel(settings?.modelThinkingLevels?.[`${provider}/${modelId}`]) ||
    normalizeThinkingLevel(settings?.defaultThinkingLevel) ||
    PI_DEFAULT_THINKING_LEVEL
  );
}

/**
 * Level for a turn: the user's level when the active model supports it,
 * otherwise `fallback` (Pi's default). Unknown support counts as unsupported.
 */
export function turnThinkingLevel(requested, supportedLevels, fallback) {
  const level = normalizeThinkingLevel(requested);
  return level && Array.isArray(supportedLevels) && supportedLevels.includes(level)
    ? level
    : fallback;
}
