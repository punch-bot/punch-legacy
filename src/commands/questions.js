import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  CheckboxGroupBuilder,
  LabelBuilder,
  MessageFlags,
} from "discord.js";
import { registry } from "../core/registry.js";
import { enqueueChat } from "../chat/queue.js";
import { buildV2AnsweredComponents } from "../chat/embeds-questions.js";

// Answered cards keep their content: V2 questions re-render their spec without
// button rows plus an answer note, since wiping components would delete the
// card's genuinely useful payload along with the interactivity.
async function settleAnswerInteraction(interaction, state, note) {
  if (!state.v2) {
    await interaction.update({ components: [] }).catch(() => {});
    return;
  }
  const components = buildV2AnsweredComponents(state.specItems, state.accent, note);
  await interaction.update({ components }).catch(() => {});
}

async function handleQuestionInteraction(interaction) {
  const state = registry.questionState.get(interaction.message.id);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;

  let chosen = [];
  if (interaction.isButton()) {
    const idx = Number(interaction.customId.split(":")[2]);
    if (!Number.isNaN(idx) && state.options[idx] != null) chosen = [state.options[idx]];
  } else if (interaction.isStringSelectMenu()) {
    for (const v of interaction.values) {
      const idx = Number(String(v).replace(/^o/, ""));
      if (!Number.isNaN(idx) && state.options[idx] != null) chosen.push(state.options[idx]);
    }
  }
  if (chosen.length === 0) {
    await interaction.reply({ content: "Invalid selection.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (!registry.questionState.delete(interaction.message.id)) {
    await interaction.reply({ content: "That question was already answered.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await settleAnswerInteraction(interaction, state, `> answered: **${chosen.map((c) => String(c).slice(0, 80)).join(", ")}**`);

  const clicker = interaction.user;
  const label = clicker.displayName || clicker.username;
  const answerText = chosen.length === 1 ? `I chose: ${chosen[0]}` : `I chose: ${chosen.join(", ")}`;
  const repliedTo = [
    "--- Question answered ---",
    `[${state.title || "Question"}]: ${chosen.map((c) => `"${c}"`).join(", ")} (answered by ${label})`,
    "--- End ---",
  ].join("\n");

  await enqueueChat(interaction.message, answerText, [], {
    userId: state.fromUserId,
    displayName: label,
    speakerUsername: clicker.username,
    repliedTo,
    forceQueue: true,
    cv2EditMessageId: state.inline ? interaction.message.id : undefined,
  });
}

async function handleQuestionAnswerModal(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = registry.questionState.get(msgId);
  if (!state || !state.input || !state.input.length) {
    await interaction.reply({ content: "This question has no input field.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const fields = state.input.slice(0, 5);
  const modal = new ModalBuilder()
    .setCustomId(`qmodal:${msgId}`)
    .setTitle((state.title || "Your answer").slice(0, 45));
  for (let i = 0; i < fields.length; i++) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`qfield:${i}`)
          .setLabel(fields[i].slice(0, 45) || `Field ${i + 1}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  }
  await interaction.showModal(modal).catch(() => {});
}

async function handleQuestionModalSubmit(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = registry.questionState.get(msgId);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const fields = (state.input || []).slice(0, 5);
  const answers = [];
  for (let i = 0; i < fields.length; i++) {
    const v = interaction.fields.getTextInputValue(`qfield:${i}`).trim();
    if (v) answers.push({ field: fields[i], value: v });
  }
  if (answers.length === 0) {
    await interaction.reply({ content: "No answer provided.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (!registry.questionState.delete(msgId)) {
    await interaction.reply({ content: "That question was already answered.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.update({ components: [] }).catch(() => {});

  const clicker = interaction.user;
  const label = clicker.displayName || clicker.username;
  const answerText = answers.map((a) => `${a.field}: ${a.value}`).join("\n");
  const repliedTo = [
    "--- Question answered ---",
    `[${state.title || "Question"}] (answered by ${label}):`,
    ...answers.map((a) => `${a.field}: "${a.value}"`),
    "--- End ---",
  ].join("\n");

  await enqueueChat(interaction.message, answerText, [], {
    userId: state.fromUserId,
    displayName: label,
    speakerUsername: clicker.username,
    repliedTo,
    forceQueue: true,
    cv2EditMessageId: state.inline ? interaction.message.id : undefined,
  });
}

async function handleQuestionCheckboxOpen(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = registry.questionState.get(msgId);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const opts = state.options.slice(0, 10);
  if (opts.length === 0) {
    await interaction.reply({ content: "This question has no options.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const group = new CheckboxGroupBuilder()
    .setCustomId(`qchkgroup:${msgId}`)
    .setMinValues(0)
    .setMaxValues(opts.length)
    .setRequired(false)
    .addOptions(opts.map((o, i) => ({ value: `o${i}`, label: o.slice(0, 100) })));
  const label = new LabelBuilder()
    .setLabel((state.title || "Select all that apply").slice(0, 45))
    .setCheckboxGroupComponent(group);
  if (state.description) label.setDescription(state.description.slice(0, 100));
  const modal = new ModalBuilder()
    .setCustomId(`qchksubmit:${msgId}`)
    .setTitle((state.title || "Choices").slice(0, 45))
    .addComponents(label);
  await interaction.showModal(modal).catch(() => {});
}

async function handleQuestionCheckboxSubmit(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = registry.questionState.get(msgId);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const field = interaction.fields.getField(`qchkgroup:${msgId}`);
  const chosen = [];
  for (const v of field?.values || []) {
    const idx = Number(String(v).replace(/^o/, ""));
    if (!Number.isNaN(idx) && state.options[idx] != null) chosen.push(state.options[idx]);
  }
  if (chosen.length === 0) {
    await interaction.reply({ content: "No options selected.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (!registry.questionState.delete(msgId)) {
    await interaction.reply({ content: "That question was already answered.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const clicker = interaction.user;
  const label = clicker.displayName || clicker.username;
  const answered = [
    "--- Question answered ---",
    `[${state.title || "Question"}]: ${chosen.map((c) => `"${c}"`).join(", ")} (answered by ${label})`,
    "--- End ---",
  ].join("\n");
  await settleAnswerInteraction(interaction, state, `> answered: **${chosen.map((c) => String(c).slice(0, 80)).join(", ")}**`);

  await enqueueChat(interaction.message, `I chose: ${chosen.join(", ")}`, [], {
    userId: state.fromUserId,
    displayName: label,
    speakerUsername: clicker.username,
    repliedTo: answered,
    forceQueue: true,
    cv2EditMessageId: state.inline ? interaction.message.id : undefined,
  });
}

export {
  handleQuestionInteraction,
  handleQuestionAnswerModal,
  handleQuestionModalSubmit,
  handleQuestionCheckboxOpen,
  handleQuestionCheckboxSubmit,
};
