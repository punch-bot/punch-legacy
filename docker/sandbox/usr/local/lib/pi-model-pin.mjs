// Keep Pi from swapping the requested model for an OpenRouter service variant.
//
// Pi resolves `--model` by exact id first, then by substring, taking the
// highest-sorting match. A bare id is a prefix of its variants, so any fuzzy
// hit lands on `<id>:free` or `<id>:batch` rather than `<id>` (upstream
// earendil-works/pi#2954, #3042). That happens when the id is missing from
// Pi's catalog (only the `:free` variant ships) or the user typed a partial id.
// OpenRouter only: other providers' colon ids (Bedrock `:0`, custom models)
// aren't service variants of a bare id.

export const PINNED_PROVIDER = "openrouter";

export const SERVICE_SUFFIXES = new Set([
  "free",
  "batch",
  "nitro",
  "floor",
  "online",
  "exacto",
  "extended",
  "thinking",
  "beta",
]);

const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** Service suffix on `resolvedId` that `requestedId` did not ask for, or null. */
export function addedServiceSuffix(requestedId, resolvedId) {
  const id = String(resolvedId || "");
  const colon = id.lastIndexOf(":");
  if (colon <= id.lastIndexOf("/")) return null;
  const suffix = id.slice(colon + 1).toLowerCase();
  if (!SERVICE_SUFFIXES.has(suffix)) return null;
  // `x/y:free` and `x/y:free:high` both ask for the variant.
  const requested = String(requestedId || "").toLowerCase();
  const tail = requested.slice(requested.lastIndexOf("/") + 1).split(":").slice(1);
  if (tail.includes(suffix)) return null;
  return suffix;
}

/**
 * models.json entry for `id`, copying metadata from the variant Pi picked.
 * Only schema-safe fields: Pi ignores the whole file if one entry is invalid.
 * Cost is left out because variant pricing differs from the base model.
 */
export function modelsJsonEntry(template, id, suffix = "") {
  const entry = { id };
  let name = String(template?.name || "");
  if (suffix) name = name.replace(new RegExp(`\\s*\\(${suffix}\\)\\s*$`, "i"), "");
  name = name.trim();
  if (name) entry.name = name;
  for (const key of ["api", "baseUrl"]) {
    if (typeof template?.[key] === "string" && template[key]) entry[key] = template[key];
  }
  if (typeof template?.reasoning === "boolean") entry.reasoning = template.reasoning;
  if (Array.isArray(template?.input)) {
    const input = template.input.filter((x) => x === "text" || x === "image");
    if (input.length) entry.input = input;
  }
  for (const key of ["contextWindow", "maxTokens"]) {
    const n = template?.[key];
    if (Number.isFinite(n) && n > 0) entry[key] = n;
  }
  return entry;
}

/**
 * How to undo a service suffix Pi added while resolving the requested model.
 * Returns null when Pi's choice is fine, `{ action: "use", id }` when the
 * unsuffixed model is already in Pi's registry, or `{ action: "register", id,
 * entry }` when it must be added to models.json first.
 */
export function planModelPin(provider, requestedId, current, available) {
  if (String(provider).toLowerCase() !== PINNED_PROVIDER) return null;
  if (!current || String(current.provider).toLowerCase() !== PINNED_PROVIDER) return null;
  const suffix = addedServiceSuffix(requestedId, current.id);
  if (!suffix) return null;
  const id = current.id.slice(0, -(suffix.length + 1));
  const known = (available || []).find(
    (m) => m?.provider === current.provider && String(m.id).toLowerCase() === id.toLowerCase(),
  );
  if (known) return { action: "use", id: known.id };
  return { action: "register", id, entry: modelsJsonEntry(current, id, suffix) };
}

/** `config` with `entry` added under providers[provider].models, or null if already there. */
export function withRegisteredModel(config, provider, entry) {
  if (!/^[a-z0-9_-]+$/i.test(String(provider || "")) || RESERVED_IDS.has(provider)) return null;
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const providers =
    base.providers && typeof base.providers === "object" && !Array.isArray(base.providers)
      ? base.providers
      : {};
  const prev =
    providers[provider] && typeof providers[provider] === "object" ? providers[provider] : {};
  const models = Array.isArray(prev.models) ? prev.models : [];
  if (models.some((m) => m?.id === entry.id)) return null;
  return {
    ...base,
    providers: { ...providers, [provider]: { ...prev, models: [...models, entry] } },
  };
}
