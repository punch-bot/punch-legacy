// Plan gate Discord surface: plan cards (in the turn's channel, DM fallback),
// approve → enqueue follow-up turn, deny/not-my-task → record + notify the
// sandbox, and the "reason" row that writes a durable per-user fact.
// Pure store/policy logic lives in src/plan-gate.js.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import * as store from "../memory.js";
import * as planGate from "../plan-gate.js";
import { apiUrlFor } from "../agent.js";
import { supervisorAuth } from "../core/config.js";
import { registry } from "../core/registry.js";
import { enqueueChat } from "../chat/queue.js";

const NOT_MY_TASK_REASONS = {
  for_agent: "for another agent",
  musing: "just musing",
  later: "later",
};

export function planCardText(pending) {
  const lines = [`📋 **Plan:** ${pending.summary}`];
  pending.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  const meta = [];
  if (pending.touches?.length) meta.push(`touches: ${pending.touches.join(", ")}`);
  if (pending.commands?.length) meta.push(`commands: ${pending.commands.join(", ")}`);
  if (pending.est) meta.push(`est ${pending.est}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (pending.origin?.startsWith("a2a:")) {
    lines.push(`-# proposed by ${pending.origin.slice(4)} — peer plans always need approval`);
  }
  return lines.join("\n").slice(0, 1900);
}

function planCardRows(pending, userSettings) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`plan_approve:${pending.planId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`plan_deny:${pending.planId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`plan_nottask:${pending.planId}`)
      .setLabel("Not my task")
      .setStyle(ButtonStyle.Secondary),
  );
  // "Approve & stop asking" is hidden for users who picked planGate=off.
  if ((userSettings?.planGate || "confirm") !== "off") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`plan_always:${pending.planId}`)
        .setLabel("Approve & stop asking")
        .setStyle(ButtonStyle.Primary),
    );
  }
  return [row];
}

function notMyTaskReasonRow(planId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`plan_reason:${planId}:for_agent`)
        .setLabel("For another agent")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`plan_reason:${planId}:musing`)
        .setLabel("Just musing")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`plan_reason:${planId}:later`)
        .setLabel("Later")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function postToChannelOrDm(userId, channelId, payload) {
  if (channelId) {
    try {
      const channel = await registry.client.channels.fetch(channelId);
      return await channel.send({ ...payload, allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`[plan-gate] channel ${channelId} delivery failed, DM fallback:`, err.message);
    }
  }
  const dm = await registry.client.users.createDM(userId);
  return dm.send(payload);
}

// Post (or attempt to post) the plan card. Auto-approved plans get a muted
// one-message audit card with no buttons.
export async function postPlanCard(pending, { autoApproved = false } = {}) {
  const userSettings = store.getUserSettings(pending.userId);
  let content = planCardText(pending);
  if (autoApproved) {
    content += `\n-# ✅ auto-approved (planGate: ${userSettings.planGate})`;
  } else if (!userSettings.planGateSeen) {
    content +=
      "\n-# Plans are new: Punch now proposes a plan before multi-step work — approve to run it. `/planmode` changes this.";
  }
  const message = await postToChannelOrDm(pending.userId, pending.channelId, {
    content,
    components: autoApproved ? [] : planCardRows(pending, userSettings),
  });
  planGate.updatePending(pending.planId, {
    cardChannelId: message.channelId,
    cardMessageId: message.id,
  });
  if (!userSettings.planGateSeen) {
    store.patchUserSettings(pending.userId, { planGateSeen: true });
  }
  return message;
}

// Tell the originating sandbox's supervisor that the plan resolved. The
// supervisor records it sandbox-side; the decision itself is already stored
// in the bot's pending file. Fire-and-forget — the card is source of truth.
export async function notifyPlanResolved(pending) {
  const base = apiUrlFor(pending.userId);
  if (!base) return;
  try {
    await fetch(`${base}/plan/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: supervisorAuth(),
      },
      body: JSON.stringify({
        planId: pending.planId,
        decision: pending.status,
        reason: pending.reason,
        summary: pending.summary,
      }),
    });
  } catch (err) {
    console.warn(`[plan-gate] resolve notify failed for ${pending.planId}:`, err.message);
  }
}

async function cardMessage(pending) {
  if (pending.cardChannelId && pending.cardMessageId) {
    try {
      const channel = await registry.client.channels.fetch(pending.cardChannelId);
      return await channel.messages.fetch(pending.cardMessageId);
    } catch {}
  }
  return null;
}

// Approve → enqueue a follow-up turn carrying the approved plan text.
// The card message doubles as the trigger message, so the reply lands in the
// same channel/DM the user approved from.
export async function runApprovedPlan(pending) {
  const trigger = (await cardMessage(pending)) || null;
  if (!trigger) {
    console.warn(`[plan-gate] no card message for ${pending.planId}; skipping approved run`);
    return;
  }
  const user = await registry.client.users.fetch(pending.userId).catch(() => null);
  const text = `(plan ${pending.planId} approved — proceed)\n\n${planCardText(pending)}`;
  await enqueueChat(trigger, text, [], {
    userId: pending.userId,
    displayName: user?.displayName || user?.username || pending.userId,
    speakerUsername: user?.username || pending.userId,
    sandboxName: pending.sandboxName,
    planOrigin: pending.origin,
    forceQueue: true,
  });
}

export async function handlePlanInteraction(interaction, action, planId) {
  const pending = planGate.getPending(planId);
  if (!pending) {
    await interaction.reply({
      content: "This plan expired.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== pending.userId) {
    await interaction.reply({
      content: "Only the plan's owner can respond to this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (pending.status !== "pending") {
    await interaction.update({ components: [] }).catch(() => {});
    return;
  }

  if (action === "plan_nottask") {
    await interaction.update({
      content: `${planCardText(pending)}\n\n**Why is this not your task?**`,
      components: notMyTaskReasonRow(planId),
    });
    return;
  }

  if (action === "plan_reason") {
    const reason = interaction.customId.split(":")[2];
    const label = NOT_MY_TASK_REASONS[reason] || reason || "not my task";
    const resolved = planGate.resolvePlan(planId, { status: "not_my_task", reason: label });
    store.remember(
      "user",
      pending.userId,
      `Plan gate: "${pending.summary}" was not a task for Punch (reason: ${label}). Don't plan-gate similar messages.`,
    );
    await interaction.update({
      content: `🚫 **Not my task** (${label}) — plan ${planId} will not run.\n\n${planCardText(pending)}`,
      components: [],
    });
    if (resolved) await notifyPlanResolved(resolved);
    return;
  }

  if (action === "plan_deny") {
    const resolved = planGate.resolvePlan(planId, { status: "denied" });
    await interaction.update({
      content: `❌ **Denied** — plan ${planId} will not run.\n\n${planCardText(pending)}`,
      components: [],
    });
    if (resolved) await notifyPlanResolved(resolved);
    return;
  }

  if (action === "plan_always") {
    store.patchUserSettings(pending.userId, { planGate: "auto" });
  }

  if (action === "plan_approve" || action === "plan_always") {
    const resolved = planGate.resolvePlan(planId, { status: "approved" });
    await interaction.update({
      content: `✅ **Approved** — plan ${planId} running.${
        action === "plan_always" ? " Plan gate set to `auto`." : ""
      }\n\n${planCardText(pending)}`,
      components: [],
    });
    if (resolved) {
      await notifyPlanResolved(resolved);
      await runApprovedPlan(resolved);
    }
  }
}
