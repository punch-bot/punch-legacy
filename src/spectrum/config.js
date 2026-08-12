/**
 * Spectrum (Photon) configuration for the Punch entrypoint.
 * Uses official env names from spectrum-ts: SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET.
 * Also accepts PROJECT_ID / PROJECT_SECRET as optional aliases (docs show both forms).
 */

export const ALLOWED_PROVIDERS = Object.freeze(["imessage", "terminal"]);
export const ALLOWED_MODES = Object.freeze(["agent", "echo"]);

export class SpectrumConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpectrumConfigError";
  }
}

function nonempty(value) {
  const s = value == null ? "" : String(value).trim();
  return s || "";
}

/**
 * Parse SPECTRUM_PROVIDERS (comma-separated). Default: imessage.
 * @param {string} [raw]
 * @returns {string[]}
 */
export function parseProviders(raw) {
  const text = nonempty(raw) || "imessage";
  const names = text
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) {
    throw new SpectrumConfigError(
      "SPECTRUM_PROVIDERS is empty. Use a comma-separated list such as: imessage,terminal",
    );
  }
  const unknown = names.filter((n) => !ALLOWED_PROVIDERS.includes(n));
  if (unknown.length) {
    throw new SpectrumConfigError(
      `Unknown Spectrum provider(s): ${unknown.join(", ")}. Allowed: ${ALLOWED_PROVIDERS.join(", ")}`,
    );
  }
  return [...new Set(names)];
}

/**
 * Parse SPECTRUM_USER_MAP JSON object. Values must be Punch sandbox user IDs (Discord snowflakes).
 * @param {string} [raw]
 * @returns {Record<string, string>}
 */
export function parseUserMap(raw) {
  const text = nonempty(raw);
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SpectrumConfigError(
      'SPECTRUM_USER_MAP must be valid JSON, e.g. {"+15551234567":"123456789012345678"}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpectrumConfigError("SPECTRUM_USER_MAP must be a JSON object of address → Punch userId.");
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const k = nonempty(key);
    const v = nonempty(value);
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Load and validate Spectrum config from an env-like object.
 * Never returns or logs secret values.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function loadSpectrumConfig(env = process.env) {
  const modeRaw = nonempty(env.SPECTRUM_MODE) || "agent";
  const mode = modeRaw.toLowerCase();
  if (!ALLOWED_MODES.includes(mode)) {
    throw new SpectrumConfigError(
      `SPECTRUM_MODE must be one of: ${ALLOWED_MODES.join(", ")} (got ${JSON.stringify(modeRaw)})`,
    );
  }

  const providers = parseProviders(env.SPECTRUM_PROVIDERS);
  const projectId =
    nonempty(env.SPECTRUM_PROJECT_ID) || nonempty(env.PROJECT_ID);
  const projectSecret =
    nonempty(env.SPECTRUM_PROJECT_SECRET) || nonempty(env.PROJECT_SECRET);
  const defaultUserId = nonempty(env.SPECTRUM_DEFAULT_USER_ID);
  const userMap = parseUserMap(env.SPECTRUM_USER_MAP);

  const needsCloudCredentials = providers.includes("imessage");
  if (needsCloudCredentials) {
    const missing = [];
    if (!projectId) missing.push("SPECTRUM_PROJECT_ID");
    if (!projectSecret) missing.push("SPECTRUM_PROJECT_SECRET");
    if (missing.length) {
      throw new SpectrumConfigError(
        `Missing ${missing.join(" and ")} required for the imessage provider. ` +
          "Create a project at https://app.photon.codes/ and copy Settings → project ID and secret into .env " +
          "(see .env.example). Official docs: https://docs.photon.codes/docs/spectrum-ts/getting-started",
      );
    }
  }

  if (mode === "agent" && !defaultUserId) {
    throw new SpectrumConfigError(
      "SPECTRUM_DEFAULT_USER_ID is required in agent mode. " +
        "Set it to a Discord user ID that already has a Punch sandbox (/sandbox create). " +
        "Optional SPECTRUM_USER_MAP can override per sender address.",
    );
  }

  return {
    mode,
    providers,
    /** Present when imessage is enabled; never log this object’s secret field. */
    projectId: projectId || undefined,
    projectSecret: projectSecret || undefined,
    defaultUserId: defaultUserId || undefined,
    userMap,
    hasProjectCredentials: Boolean(projectId && projectSecret),
  };
}

/**
 * Format a startup error for stderr without leaking secrets.
 * @param {unknown} err
 */
export function formatConfigError(err) {
  if (err instanceof SpectrumConfigError) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String(/** @type {{ message: unknown }} */ (err).message);
  }
  return String(err);
}
