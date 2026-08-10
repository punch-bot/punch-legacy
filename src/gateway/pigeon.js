// Agent pigeon delivery and permission handling. Wire-in: interaction handlers
// use these to route approved agent pigeons into the recipient's chat queue.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import * as store from "../memory.js";
import * as sandbox from "../sandbox-manager.js";
import * as pigeonGate from "../pigeon-gate.js";
import { sandboxNameForUser } from "../agent.js";
import { assessAgentPigeon } from "../pigeon-supervisor.js";
import { ensureUserSandbox } from "../core/supervisor.js";
import { registry } from "../core/registry.js";
import { safeReact } from "../core/discord.js";
import { enqueueChat } from "../chat/queue.js";

export async function notifyPigeonDM(recipientId, from, text) {
  try {
    const user = await registry.client.users.fetch(recipientId);
    const dm = await user.createDM();
    await dm.send({
      content: `📬 **Pigeon message from ${from}**\n\n${text}`,
      allowedMentions: { parse: [] },
    });
    console.log(`[pigeon] notified ${recipientId} (${from}): ${text.slice(0, 80)}`);
  } catch (err) {
    console.error(`[pigeon] failed to DM ${recipientId}:`, err.message);
  }
}

export async function notifyPigeonBlocked(recipientId, from, reason) {
  try {
    const user = await registry.client.users.fetch(recipientId);
    const dm = await user.createDM();
    await dm.send(
      `Agent pigeon from **${from}** was blocked: ${reason}. Message was not executed.`,
    );
    console.log(`[pigeon] blocked agent pigeon for ${recipientId} from ${from}: ${reason}`);
  } catch (err) {
    console.error(`[pigeon] failed to DM block notice to ${recipientId}:`, err.message);
  }
}

export async function notifyPigeonSender(senderSandbox, recipientId, text) {
  const uid = pigeonGate.userIdForSandboxName(senderSandbox);
  const recipientSandbox = sandboxNameForUser(recipientId);
  if (uid && recipientSandbox) await notifyPigeonDM(uid, recipientSandbox, text);
}

export function pigeonEnqueueOpts(recipientId, from, hop, sandboxName) {
  return {
    userId: recipientId,
    displayName: from,
    speakerUsername: from,
    pigeonFrom: from,
    pigeonHop: hop,
    sandboxName,
    forceQueue: true,
  };
}

export async function runApprovedAgentPigeon(pending, pendingId = null) {
  const { recipientId, from, text, hop } = pending;
  const hopNum = Number(hop) || 0;
  const userSettings = store.getUserSettings(recipientId);
  pigeonGate.recordPigeon(recipientId, from);

  const sandboxUrl = await ensureUserSandbox(recipientId);
  if (!sandboxUrl) {
    await notifyPigeonDM(recipientId, from, text);
    return;
  }

  try {
    const user = await registry.client.users.fetch(recipientId);
    const dm = await user.createDM();
    const bufferSec = pigeonGate.clampBufferSeconds(userSettings.pigeonBufferSeconds);
    const intro = bufferSec
      ? `📬 **Agent pigeon from ${from}** — runs in **${bufferSec}s**. React 🛑 to cancel.\n\n${text}`
      : `📬 **Agent pigeon from ${from}**\n\n${text}`;
    const triggerMsg = await dm.send(intro);
    const sandboxName = sandbox.loadUsers().find((u) => u.userId === recipientId)?.name;

    if (bufferSec > 0) {
      await safeReact(triggerMsg, "🛑");
    }

    console.log(`[pigeon] agent wake uid=${recipientId} from=${from} hop=${hopNum} buffer=${bufferSec}s`);

    const run = async () => {
      const activeId = pendingId || buffPendingId;
      if (activeId) {
        const p = pigeonGate.getPending(activeId);
        if (p?.status === "cancelled") return;
        pigeonGate.deletePending(activeId);
      }
      await enqueueChat(
        triggerMsg,
        `${text}\n(agent pigeon task — act on the message above)`,
        [],
        pigeonEnqueueOpts(recipientId, from, hopNum, sandboxName),
      );
    };

    const buffPendingId = pendingId
      || (bufferSec > 0
        ? pigeonGate.createPending({ recipientId, from, text, hop: hopNum })
        : null);

    if (bufferSec > 0 && buffPendingId) {
      pigeonGate.updatePending(buffPendingId, { status: "approved" });
      const sched = pigeonGate.scheduleExecution({
        pendingId: buffPendingId,
        bufferSec,
        onRun: run,
        onCancel: async () => {
          await triggerMsg.edit(`🛑 **Agent pigeon cancelled** (from **${from}**).`).catch(() => {});
          await notifyPigeonSender(from, recipientId, "Your agent pigeon was cancelled during the buffer.");
        },
      });
      sched?.trackMessage(triggerMsg.id);
    } else {
      await run();
    }
  } catch (err) {
    console.error(`[pigeon] agent wake failed for ${recipientId}:`, err.message);
    await notifyPigeonDM(recipientId, from, text);
  }
}

export async function sendPermissionDM(recipientId, from, text, hop) {
  const pendingId = pigeonGate.createPending({ recipientId, from, text, hop });
  const user = await registry.client.users.fetch(recipientId);
  const dm = await user.createDM();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pigeon_allow:${pendingId}`)
      .setLabel("Allow once")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pigeon_deny:${pendingId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`pigeon_trust:${pendingId}`)
      .setLabel(`Always allow ${from}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pigeon_deny_always:${pendingId}`)
      .setLabel(`Always deny ${from}`)
      .setStyle(ButtonStyle.Secondary),
  );
  await dm.send({
    content: `📬 **Agent pigeon from ${from}** — allow your Punch to run this?\n\n${text}`,
    components: [row],
  });
  console.log(`[pigeon] permission pending ${pendingId} uid=${recipientId} from=${from}`);
}

export async function handleAgentPigeon(recipientId, from, text, hop) {
  const hopNum = Number(hop) || 0;
  const assessment = assessAgentPigeon({ text, from, hop: hopNum });
  if (!assessment.allow) {
    await notifyPigeonBlocked(recipientId, from, assessment.reason);
    return;
  }

  const userSettings = store.getUserSettings(recipientId);
  if (pigeonGate.isDeniedSender({ from, userSettings })) {
    await notifyPigeonBlocked(recipientId, from, `sender **${from}** is on your deny list`);
    await notifyPigeonSender(from, recipientId, "Your agent pigeon was **blocked** — the recipient has denied pigeons from your sandbox.");
    return;
  }

  if (!userSettings.workingPigeonsEnabled) {
    await notifyPigeonDM(recipientId, from, text);
    return;
  }

  const rate = pigeonGate.checkRateLimit(recipientId, from, userSettings);
  if (!rate.ok) {
    await notifyPigeonDM(recipientId, from, `_(not run — ${rate.reason})_\n\n${text}`);
    await notifyPigeonSender(from, recipientId, `Agent pigeon was rate-limited: ${rate.reason}`);
    return;
  }

  const sandboxUrl = await ensureUserSandbox(recipientId);
  if (!sandboxUrl) {
    await notifyPigeonDM(recipientId, from, text);
    return;
  }

  if (pigeonGate.shouldSkipPermission({ from, hop: hopNum, userSettings })) {
    await runApprovedAgentPigeon({ recipientId, from, text, hop: hopNum });
    return;
  }

  await sendPermissionDM(recipientId, from, text, hopNum);
}
