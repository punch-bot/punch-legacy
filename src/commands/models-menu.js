import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";

import { MODEL_LIST, THINKING_LEVEL_LIST } from "../core/config.js";

export const MODELS_MENU_TTL_MS = 5 * 60_000;
export const MODEL_SELECT_ID = "model_select";
export const THINKING_SELECT_ID = "thinking_select";
export const PROVIDER_SELECT_ID = "provider_select";
export const MODEL_PAGE_ID = "model_page";
export const MODEL_BACK_ID = "model_back";
export const CUSTOM_MODEL_MODAL_ID = "custom_model";
export const MODELS_MENU_EXPIRED = "⌛ This menu expired. Run `/models` again to change your model or reasoning level.";
export const MODELS_PER_PAGE = 15;

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
  const content = [
    notice,
    `**Model:** \`${model}\``,
    `**Reasoning:** ${thinkingLevelLabel(thinkingLevel || "default")}`,
    providers.length
      ? `-# Pick a provider, then a model. Custom model... comes first, known families sort to the top. Menu expires <t:${Math.floor(expiresAt / 1000)}:R>.`
      : `-# Pick a model. Menu expires <t:${Math.floor(expiresAt / 1000)}:R>.`,
  ].filter(Boolean).join("\n");
  const rows = [];
  if (!providers.length) {
    rows.push(flatModelRow({ model, expiresAt }));
    rows.push(thinkingRow(thinkingLevel, expiresAt));
    return { content, components: rows };
  }
  if (providers.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(modelsMenuCustomId(PROVIDER_SELECT_ID, expiresAt))
        .setPlaceholder("Choose a provider")
        .addOptions(providers.slice(0, 25).map((p) => ({
          label: p.name,
          value: p.name,
          description: p.count == null ? undefined : `${p.count} model${p.count === 1 ? "" : "s"}`,
        }))),
    ));
  }
  rows.push(thinkingRow(thinkingLevel, expiresAt));
  return { content, components: rows };
}

export function renderProviderModels({ provider, models, page = 0, expiresAt, model, thinkingLevel, notice = "", now = Date.now() }) {
  if (modelsMenuExpired(expiresAt, now)) {
    return { content: [notice, MODELS_MENU_EXPIRED].filter(Boolean).join("\n"), components: [] };
  }
  const sorted = sortModelsForMenu(models);
  const { page: safePage, pages, slice } = modelPage(sorted, page);
  const current = sorted.find((m) => m.value === model);
  const content = [
    notice,
    `**Model:** \`${model}\``,
    `**Provider:** \`${provider}\` · page ${safePage + 1}/${pages}`,
    current?.contextWindow ? `**Context:** ${Math.round(current.contextWindow / 1000)}k` : null,
    `-# Menu expires <t:${Math.floor(expiresAt / 1000)}:R>.`,
  ].filter(Boolean).join("\n");
  const modelOptions = [
    { label: "Custom model...", value: "__custom__", description: "Type any provider/model id" },
    ...slice.map((m) => ({
      label: String(m.label || m.value).slice(0, 100),
      value: m.value,
      description: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context${m.value === model ? " · current" : ""}` : (m.value === model ? "Currently selected" : undefined),
    })),
  ];
  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_SELECT_ID, expiresAt))
        .setPlaceholder(`Model: ${model}`.slice(0, 150))
        .addOptions(modelOptions.slice(0, 25)),
    ),
  ];
  if (pages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_PAGE_ID, expiresAt, provider, String(safePage - 1)))
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_PAGE_ID, expiresAt, provider, String(safePage + 1)))
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= pages - 1),
      new ButtonBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_BACK_ID, expiresAt))
        .setLabel("Providers")
        .setStyle(ButtonStyle.Primary),
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(modelsMenuCustomId(MODEL_BACK_ID, expiresAt))
        .setLabel("Providers")
        .setStyle(ButtonStyle.Secondary),
    ));
  }
  rows.push(thinkingRow(thinkingLevel, expiresAt));
  return { content, components: rows };
}

export function renderModelsMenu({ model, thinkingLevel, expiresAt, notice = "", now = Date.now(), providers = [] }) {
  return renderProviderMenu({ model, thinkingLevel, expiresAt, providers, notice, now });
}
