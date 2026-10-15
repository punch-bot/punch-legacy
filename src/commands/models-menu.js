// /models menu: a model dropdown and a reasoning-level dropdown. The menu
// stays usable for repeated picks until it expires; the expiry is part of each
// custom id, so a stale click is caught even after a bot restart.
import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

import { MODEL_LIST, THINKING_LEVEL_LIST } from "../core/config.js";

export const MODELS_MENU_TTL_MS = 5 * 60_000;
export const MODEL_SELECT_ID = "model_select";
export const THINKING_SELECT_ID = "thinking_select";
export const CUSTOM_MODEL_MODAL_ID = "custom_model";
export const MODELS_MENU_EXPIRED = "⌛ This menu expired. Run `/models` again to change your model or reasoning level.";

export function modelsMenuCustomId(base, expiresAt) {
  return `${base}:${expiresAt}`;
}

/** `{ base, expiresAt }`; ids without an expiry (older menus) get 0, i.e. expired. */
export function parseModelsMenuCustomId(customId) {
  const [base, ts] = String(customId).split(":");
  const expiresAt = Number(ts);
  return { base, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
}

export function modelsMenuExpired(expiresAt, now = Date.now()) {
  return !(expiresAt > now);
}

export function thinkingLevelLabel(level) {
  return (THINKING_LEVEL_LIST.find((l) => l.value === (level || "default")) || { label: level }).label;
}

/** Message payload for the menu; after expiry, only the notice and the expiry note. */
export function renderModelsMenu({ model, thinkingLevel, expiresAt, notice = "", now = Date.now() }) {
  if (modelsMenuExpired(expiresAt, now)) {
    return { content: [notice, MODELS_MENU_EXPIRED].filter(Boolean).join("\n"), components: [] };
  }
  const level = thinkingLevel || "default";
  const content = [
    notice,
    `**Model:** \`${model}\``,
    `**Reasoning:** ${thinkingLevelLabel(level)}${level === "default" ? "" : " (models without this level use their default)"}`,
    `-# Pick as often as you like until this menu expires <t:${Math.floor(expiresAt / 1000)}:R>. "Custom model..." lets you type any model id.`,
  ].filter(Boolean).join("\n");
  const modelRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(modelsMenuCustomId(MODEL_SELECT_ID, expiresAt))
      .setPlaceholder(`Model: ${model}`.slice(0, 150))
      .addOptions(MODEL_LIST.map((m) => ({
        label: m.label,
        value: m.value,
        description: m.value === model ? "Currently selected" : undefined,
      }))),
  );
  const thinkingRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(modelsMenuCustomId(THINKING_SELECT_ID, expiresAt))
      .setPlaceholder(`Reasoning: ${thinkingLevelLabel(level)}`)
      .addOptions(THINKING_LEVEL_LIST.map((l) => ({
        label: l.label,
        value: l.value,
        description: l.value === level ? "Currently selected" : l.description,
      }))),
  );
  return { content, components: [modelRow, thinkingRow] };
}
