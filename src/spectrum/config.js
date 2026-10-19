export const ALLOWED_PROVIDERS = Object.freeze(["imessage", "terminal"]);
export const ALLOWED_MODES = Object.freeze(["agent", "echo"]);

export const SAFE_STARTUP_ERROR =
  "Spectrum startup failed. Check configuration and Photon project credentials (details omitted to avoid leaking secrets).";

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
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const k = nonempty(key);
    const v = nonempty(value);
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

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
  const mapSize = Object.keys(userMap).length;
  const hasImessage = providers.includes("imessage");
  const hasTerminal = providers.includes("terminal");

  const needsCloudCredentials = hasImessage;
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

  if (mode === "agent") {
    if (hasTerminal && !hasImessage && !defaultUserId && mapSize === 0) {
      throw new SpectrumConfigError(
        "Agent mode with the terminal provider requires SPECTRUM_DEFAULT_USER_ID or SPECTRUM_USER_MAP.",
      );
    }
  }

  return {
    mode,
    providers,
    projectId: projectId || undefined,
    projectSecret: projectSecret || undefined,
    defaultUserId: defaultUserId || undefined,
    userMap,
    hasProjectCredentials: Boolean(projectId && projectSecret),
  };
}

export function formatConfigError(err) {
  if (err instanceof SpectrumConfigError) return err.message;
  return SAFE_STARTUP_ERROR;
}
