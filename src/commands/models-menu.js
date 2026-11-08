import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";

import { MODEL_LIST, THINKING_LEVEL_LIST } from "../core/config.js";

export const MODELS_MENU_TTL_MS = 5 * 60_000;
export const MODEL_SELECT_ID = "model_select";
export const THINKING_SELECT_ID = "thinking_select";
export const PROVIDER_SELECT_ID = "provider_select";
export const VENDOR_SELECT_ID = "vendor_select";
export const MODEL_PAGE_ID = "model_page";
export const MODEL_BACK_ID = "model_back";
export const CUSTOM_MODEL_MODAL_ID = "custom_model";
export const MODELS_MENU_EXPIRED = "⌛ This menu expired. Run `/models` again to change your model or reasoning level.";
export const MODELS_PER_PAGE = 15;
export const ALL_VENDORS = "-";

const PROVIDER_PRIORITY = [
  "claude",
  "gpt",
  "gemini",
  "deepseek",
  "glm",
  "mistral",
  "qwen",
  "mimo",
  "minimax",
  "muse",
];

export function modelsMenuCustomId(base, expiresAt, ...rest) {
  return [base, ...rest, expiresAt].join(":");
}

export function parseModelsMenuCustomId(customId) {
  const parts = String(customId).split(":");
  const expiresAt = Number(parts[parts.length - 1]);
  return {
    base: parts[0],
    args: parts.slice(1, -1),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

export function modelsMenuExpired(expiresAt, now = Date.now()) {
  return !(expiresAt > now);
}

export function thinkingLevelLabel(level) {
  return (THINKING_LEVEL_LIST.find((l) => l.value === (level || "default")) || { label: level }).label;
}

export function modelPriority(id) {
  const text = String(id || "").toLowerCase();
  const index = PROVIDER_PRIORITY.findIndex((family) => text.includes(family));
  return index === -1 ? PROVIDER_PRIORITY.length : index;
}

export function sortModelsForMenu(models) {
  return [...models].sort((a, b) => {
    const byFamily = modelPriority(a.value) - modelPriority(b.value);
    if (byFamily !== 0) return byFamily;
    return String(a.value).localeCompare(String(b.value));
  });
}

export function pageCount(total, pageSize = MODELS_PER_PAGE) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function modelPage(models, page, pageSize = MODELS_PER_PAGE) {
  const total = pageCount(models.length, pageSize);
  const safePage = Math.min(Math.max(0, page), total - 1);
  return {
    page: safePage,
    pages: total,
    slice: models.slice(safePage * pageSize, safePage * pageSize + pageSize),
  };
}

export function vendorOf(value, provider) {
  const rest = String(value || "").slice(String(provider || "").length + 1);
  return rest.includes("/") ? rest.split("/")[0] : "";
}

export function vendorChoices(models, provider) {
  const counts = new Map();
  for (const model of models) {
    const vendor = vendorOf(model.value, provider);
    counts.set(vendor, (counts.get(vendor) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([vendor]) => vendor)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
}

export function filterByVendor(models, provider, vendor) {
  if (!vendor || vendor === ALL_VENDORS) return models;
  return models.filter((model) => vendorOf(model.value, provider) === vendor);
}

export function formatCount(count) {
  return count == null ? undefined : `${count} model${count === 1 ? "" : "s"}`;
}

export function formatContext(window) {
  if (!window) return null;
  const million = 1_000_000;
  if (window >= million) {
    const value = window / million;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}mil`;
  }
  return `${Math.round(window / 1000)}k`;
}

function thinkingRow(level, expiresAt) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(modelsMenuCustomId(THINKING_SELECT_ID, expiresAt))
      .setPlaceholder(`Reasoning: ${thinkingLevelLabel(level)}`)
      .addOptions(THINKING_LEVEL_LIST.map((l) => ({
        label: l.label,
        value: l.value,
        description: l.value === level ? "Currently selected" : l.description,
      }))),
  );
}

function currentBlock({ model, label, provider, contextWindow, description }) {
  const head = label && label !== model ? label : `\`${model}\``;
  const meta = [provider || "unknown provider", contextWindow ? `${formatContext(contextWindow)} context` : null].filter(Boolean).join(" · ");
  return [
    `### Current model: ${head}`,
    `-# ${meta}`,
    description ? description : null,
  ].filter(Boolean).join("\n");
}

export function modelsMenuOptions(extraModels = [], log = console.log) {
  const custom = MODEL_LIST.filter((m) => m.value === "__custom__");
  const incoming = (extraModels || []).filter((m) => m && m.value);
  const providerOf = (value) => String(value).split("/")[0];
  const catalogProviders = new Set(incoming.map((m) => providerOf(m.value)));
  const builtin = MODEL_LIST.filter((m) => m.value !== "__custom__" && !catalogProviders.has(providerOf(m.value)));
  const shownValues = new Set(builtin.map((m) => m.value));
  const extras = incoming.filter((m) => !shownValues.has(m.value));
  const room = Math.max(0, 25 - builtin.length - custom.length);
  const shown = extras.slice(0, room);
  if (shown.length < extras.length) {
    log(`[models] catalog truncated: ${extras.length - shown.length} model(s) do not fit in the select menu`);
  }
  const options = [...builtin, ...shown, ...custom];
  return options.map((m) => ({
    label: m.label,
    value: m.value,
    description: m.description || undefined,
  }));
}

export function flatModelRow({ model, expiresAt, extraModels = [] }) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(modelsMenuCustomId(MODEL_SELECT_ID, expiresAt))
      .setPlaceholder(`Model: ${model}`.slice(0, 150))
      .addOptions(modelsMenuOptions(extraModels).map((m) => ({
        label: m.label,
        value: m.value,
        description: m.value === model ? "Currently selected" : m.description,
      }))),
  );
}

export function renderProviderMenu({ model, thinkingLevel, expiresAt, providers = [], notice = "", now = Date.now() }) {
  if (modelsMenuExpired(expiresAt, now)) {
    return { content: [notice, MODELS_MENU_EXPIRED].filter(Boolean).join("\n"), components: [] };
  }
  const currentProvider = String(model || "").split("/")[0];
  const currentLabel = (MODEL_LIST.find((m) => m.value === model) || {}).label;
  const content = [
    notice,
    currentBlock({ model, label: currentLabel, provider: currentProvider }),
    providers.length ? `-# Pick a provider, then a vendor and model if it offers one. Expires <t:${Math.floor(expiresAt / 1000)}:R>.` : `-# Pick a model. Expires <t:${Math.floor(expiresAt / 1000)}:R>.`,
  ].filter(Boolean).join("\n");
  if (!providers.length) {
    return { content, components: [flatModelRow({ model, expiresAt }), thinkingRow(thinkingLevel, expiresAt)] };
  }
  return {
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(modelsMenuCustomId(PROVIDER_SELECT_ID, expiresAt))
          .setPlaceholder(`Provider (currently ${currentProvider || "none"})`.slice(0, 150))
          .addOptions(providers.slice(0, 25).map((p) => ({
            label: p.name,
            value: p.name,
            description: formatCount(p.count),
          }))),
      ),
      thinkingRow(thinkingLevel, expiresAt),
    ],
  };
}

export function renderProviderModels({
  provider,
  models,
  page = 0,
  vendor = ALL_VENDORS,
  expiresAt,
  model,
  modelLabel,
  modelDescription,
  modelContextWindow,
  thinkingLevel,
  notice = "",
  now = Date.now(),
}) {
  if (modelsMenuExpired(expiresAt, now)) {
    return { content: [notice, MODELS_MENU_EXPIRED].filter(Boolean).join("\n"), components: [] };
  }
  const vendors = vendorChoices(models, provider);
  const scoped = filterByVendor(models, provider, vendor);
  const sorted = sortModelsForMenu(scoped);
  const { page: safePage, pages, slice } = modelPage(sorted, page);
  const content = [
    notice,
    currentBlock({
      model,
      label: modelLabel,
      provider: String(model || "").split("/")[0],
      contextWindow: modelContextWindow,
      description: modelDescription,
    }),
    `-# ${vendor !== ALL_VENDORS ? `${provider} / ${vendor} · ` : ""}expires <t:${Math.floor(expiresAt / 1000)}:R>.`,
  ].filter(Boolean).join("\n");

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_BACK_ID, expiresAt))
        .setLabel("← Back to providers")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_BACK_ID, expiresAt, provider))
        .setLabel(`Selected provider: ${provider}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];

  if (vendors.length > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(modelsMenuCustomId(VENDOR_SELECT_ID, expiresAt, provider))
        .setPlaceholder(vendor === ALL_VENDORS ? "Vendor: all" : `Vendor: ${vendor}`)
        .addOptions([
          { label: "All vendors", value: ALL_VENDORS, description: formatCount(models.length) },
          ...vendors.slice(0, 24).map((v) => ({ label: v.name, value: v.name, description: formatCount(v.count) })),
        ]),
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(modelsMenuCustomId(MODEL_SELECT_ID, expiresAt))
      .setPlaceholder(`Model: ${model}`.slice(0, 150))
      .addOptions([
        { label: "Custom model...", value: "__custom__", description: "Type any provider/model id" },
        ...slice.map((m) => ({
          label: String(m.label || m.value).slice(0, 100),
          value: m.value,
          description: [formatContext(m.contextWindow) ? `${formatContext(m.contextWindow)} context` : null, m.value === model ? "current" : null].filter(Boolean).join(" · ") || undefined,
        })),
      ].slice(0, 25)),
  ));

  rows.push(thinkingRow(thinkingLevel, expiresAt));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(modelsMenuCustomId(MODEL_PAGE_ID, expiresAt, provider, vendor, String(safePage - 1)))
      .setLabel("←")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(modelsMenuCustomId(MODEL_PAGE_ID, expiresAt, provider, vendor, String(safePage)))
      .setLabel(`Page ${safePage + 1} / ${pages} · ${sorted.length} model${sorted.length === 1 ? "" : "s"}`.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(modelsMenuCustomId(MODEL_PAGE_ID, expiresAt, provider, vendor, String(safePage + 1)))
      .setLabel("→")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= pages - 1),
  ));

  return { content, components: rows };
}

export function renderModelsMenu({ model, thinkingLevel, expiresAt, notice = "", now = Date.now(), providers = [] }) {
  return renderProviderMenu({ model, thinkingLevel, expiresAt, providers, notice, now });
}
