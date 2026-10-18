import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import * as store from "../memory.js";
import * as sandbox from "../sandbox-manager.js";
import * as settings from "../settings.js";
import * as statistics from "../statistics.js";
import * as state from "../state.js";
import * as routines from "../routines.js";
import * as logs from "../logs.js";
import * as collabs from "../collabs.js";

import {
  apiUrlFor,
  getEnv,
  getFile,
  getWorkerSettings,
  killBackgroundTask,
  listBackgroundTasks,
  reloadSandboxMap,
  sandboxNameForUser,
  setEnv,
  summarizeSession,
  syncWorkerCap,
} from "../agent.js";

import { PROVIDER_NAMES, isBotOwner, supervisorAuth } from "../core/config.js";
import { registry } from "../core/registry.js";
import { createDoctorRepairToken, progressBar } from "../core/discord.js";
import { validateAutoCompressThreshold } from "../context-compression.js";
import { settingsDeps } from "../chat/context.js";
import { enqueueChat, withUserRunLock } from "../chat/queue.js";
import { formatInTimeZone } from "../timezone.js";
import { renderDoctorReport, runDoctor } from "../doctor/index.js";
import * as pigeonGate from "../pigeon-gate.js";

import {
  handleQuestionInteraction,
  handleQuestionAnswerModal,
  handleQuestionModalSubmit,
  handleQuestionCheckboxOpen,
  handleQuestionCheckboxSubmit,
} from "./questions.js";

import {
  routineContextFromInteraction,
  statisticsExtrasForUser,
  userTimeZone,
  sendLogReply,
} from "./prefix.js";

import { runApprovedAgentPigeon, handleAgentPigeon, notifyPigeonDM } from "../gateway/pigeon.js";

import {
  CUSTOM_MODEL_MODAL_ID,
  MODELS_MENU_EXPIRED,
  MODELS_MENU_TTL_MS,
  MODEL_SELECT_ID,
  THINKING_SELECT_ID,
  modelsMenuCustomId,
  modelsMenuExpired,
  parseModelsMenuCustomId,
  renderModelsMenu,
  thinkingLevelLabel,
} from "./models-menu.js";

// Supervisor model API for /models: GET without a body, POST with one.
async function modelsSupervisor(uid, path, body) {
  const auth = supervisorAuth();
  const res = await fetch(`${apiUrlFor(uid)}${path}`, body === undefined
    ? { headers: { authorization: auth } }
    : { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `supervisor API ${res.status}`), { status: res.status });
  return data;
}

// The /models menu re-rendered with the sandbox's current model and level.
async function modelsMenuFor(uid, expiresAt, notice) {
  try {
    const { model, thinkingLevel } = await modelsSupervisor(uid, "/model");
    return renderModelsMenu({ model, thinkingLevel, expiresAt, notice });
  } catch (err) {
    return { content: [notice, `⚠️ Error fetching model: ${err.message}`].filter(Boolean).join("\n"), components: [] };
  }
}

async function setModelNotice(uid, model) {
  try {
    const { model: saved } = await modelsSupervisor(uid, "/model", { model });
    return `✅ Model changed to \`${saved || model}\`. Sandbox LLM process restarting…`;
  } catch (err) {
    return `⚠️ Failed to set model: ${err.message}`;
  }
}

// Memory commands answer instead of failing the interaction while the store is
// unavailable (MEMORY_UNAVAILABLE). Callers treat `undefined` as handled.
async function memoryReplyGuard(interaction, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`[memory] /memory command failed:`, error.message);
    await interaction.editReply("Memory is unavailable right now. Run `/doctor` and restore the store, then retry.")
      .catch(() => {});
    return undefined;
  }
}

export function registerInteractions(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith("stats:")) {
      await statistics.handleStatisticsInteraction(interaction, statisticsExtrasForUser);
      return;
    }

    if (interaction.isButton() && (interaction.customId.startsWith("docfix:") || interaction.customId.startsWith("docconfirm:"))) {
      const [kind, token] = interaction.customId.split(":");
      const repair = registry.doctorRepairTokens.get(token);
      if (!repair || repair.expiresAt < Date.now()) {
        registry.doctorRepairTokens.delete(token);
        await interaction.reply({ content: "This doctor repair expired. Run `/doctor` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== repair.requesterId) {
        await interaction.reply({ content: "Only the user who ran `/doctor` can apply this repair.", flags: MessageFlags.Ephemeral });
        return;
      }
      const mapping = sandbox.loadUsers().find((entry) => entry.name === repair.sandboxName);
      if (!mapping) {
        registry.doctorRepairTokens.delete(token);
        await interaction.reply({ content: "Sandbox mapping no longer exists.", flags: MessageFlags.Ephemeral });
        return;
      }
      const stillOwnsSandbox = mapping.userId === interaction.user.id;
      const canManageServer = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === interaction.user.id;
      if (!stillOwnsSandbox && !canManageServer) {
        registry.doctorRepairTokens.delete(token);
        await interaction.reply({ content: "You no longer have permission to repair this sandbox.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (repair.action === "reset-browser" && kind !== "docconfirm") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`docconfirm:${token}`)
            .setLabel("Delete browser profile and saved logins")
            .setStyle(ButtonStyle.Danger),
        );
        await interaction.reply({
          content: "**Warning:** Resetting the browser profile permanently removes saved browser sessions, cookies, and logins.",
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      registry.doctorRepairTokens.delete(token);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        let message;
        if (repair.action === "restart-container") {
          const restarted = await sandbox.restartContainer(repair.sandboxName);
          if (!restarted.ok) throw new Error(restarted.error);
          message = `Sandbox **${repair.sandboxName}** restarted.`;
        } else {
          const apiUrl = apiUrlFor(mapping.userId);
          if (!apiUrl) throw new Error("Sandbox supervisor URL is unavailable");
          const auth = supervisorAuth();
          const response = await fetch(`${apiUrl}/doctor/fix`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: auth,
              "x-punch-doctor-token": sandbox.doctorTokenFor(mapping.name),
            },
            body: JSON.stringify({ action: repair.action }),
            signal: AbortSignal.timeout(30_000),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.success) throw new Error(body.error || body.message || `supervisor API ${response.status}`);
          message = body.message;
        }
        await interaction.editReply(`✅ ${message} Run \`/doctor\` again after services settle.`);
      } catch (error) {
        await interaction.editReply(`⚠️ Repair failed: ${error.message}`);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("qbtn:")) {
      await handleQuestionInteraction(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("qsel:")) {
      await handleQuestionInteraction(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("qans:")) {
      await handleQuestionAnswerModal(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("qchk:")) {
      await handleQuestionCheckboxOpen(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("qchksubmit:")) {
      await handleQuestionCheckboxSubmit(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("qmodal:")) {
      await handleQuestionModalSubmit(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "kill_select") {
      const pid = parseInt(interaction.values[0]);
      const uid = interaction.user.id;

      try {
        await killBackgroundTask(pid, uid);
        await interaction.reply({ content: `🛑 Killed process \`${pid}\`.`, flags: MessageFlags.Ephemeral });

        const res = await listBackgroundTasks(uid);
        const tasks = res.tasks || [];

        if (tasks.length === 0) {
          await interaction.message.edit({
            content: "No active background tasks running in the sandbox.",
            embeds: interaction.message.embeds,
            components: []
          });
        } else {
          const embed = new EmbedBuilder()
            .setTitle("🏃 Active Background Tasks")
            .setDescription(tasks.map(t => {
              const shortCmd = t.cmd.length > 60 ? t.cmd.slice(0, 57) + "..." : t.cmd;
              return `\`\`${t.pid}\`\` | ${t.stat} | ${t.start} | \`${shortCmd}\``;
            }).join("\n"))
            .setColor(0x00ff99);

          const selectOptions = tasks.slice(0, 25).map(t => ({
            label: `PID ${t.pid}`,
            description: `${t.stat} | ${t.cmd.slice(0, 100)}`,
            value: String(t.pid),
          }));

          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("kill_select")
              .setPlaceholder("Select a process to kill...")
              .addOptions(selectOptions)
          );

          await interaction.message.edit({ embeds: [embed], components: [row] });
        }
      } catch (err) {
        await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isButton()) {
      const [action, pendingId] = (interaction.customId || "").split(":");
      if (pendingId?.startsWith("pg_") && (action === "pigeon_allow" || action === "pigeon_deny" || action === "pigeon_trust" || action === "pigeon_deny_always")) {
        const pending = pigeonGate.getPending(pendingId);
        if (!pending) {
          await interaction.reply({ content: "This pigeon request expired.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (interaction.user.id !== pending.recipientId) {
          await interaction.reply({ content: "Only the recipient can respond to this.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === "pigeon_deny") {
          pigeonGate.deletePending(pendingId);
          await interaction.update({
            content: `❌ **Denied** agent pigeon from **${pending.from}**.`,
            components: [],
          });
          const senderUid = pigeonGate.userIdForSandboxName(pending.from);
          const recipientSandbox = sandboxNameForUser(pending.recipientId);
          if (senderUid && recipientSandbox) {
            await notifyPigeonDM(senderUid, recipientSandbox, `Your agent pigeon to **${recipientSandbox}** was **denied**.`);
          }
          return;
        }
        if (action === "pigeon_deny_always") {
          try {
            settings.setPigeonDeny(pending.recipientId, "add", pending.from);
          } catch (err) {
            await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
            return;
          }
          pigeonGate.deletePending(pendingId);
          await interaction.update({
            content: `🚫 **Always denied** agent pigeons from **${pending.from}**.`,
            components: [],
          });
          const senderUid = pigeonGate.userIdForSandboxName(pending.from);
          const recipientSandbox = sandboxNameForUser(pending.recipientId);
          if (senderUid && recipientSandbox) {
            await notifyPigeonDM(senderUid, recipientSandbox, `Your agent pigeon to **${recipientSandbox}** was **denied** and your sandbox was added to their blocklist.`);
          }
          return;
        }
        if (action === "pigeon_trust") {
          try {
            settings.setPigeonTrust(pending.recipientId, "add", pending.from);
          } catch (err) {
            await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
            return;
          }
        }
        pigeonGate.updatePending(pendingId, { status: "approved" });
        await interaction.update({
          content: `✅ **Approved** agent pigeon from **${pending.from}**.`,
          components: [],
        });
        await runApprovedAgentPigeon(pending, pendingId);
        return;
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "pair") {
      const code = interaction.options.getString("code", true);
      const { completePairing, formatPairingCompleteMessage } = await import("../spectrum/pairing.js");
      const result = completePairing(code, interaction.user.id);
      if (!result.ok) {
        await interaction.reply({ content: `⚠️ ${result.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      const hasSandbox = !!apiUrlFor(interaction.user.id);
      const next = hasSandbox
        ? "Text Punch again from that number and you'll land in your sandbox."
        : "You still need a sandbox — ask an admin for `/sandbox create <name> " +
          interaction.user.id +
          "` then text Punch again.";
      const discordName =
        interaction.member?.displayName ||
        interaction.user.globalName ||
        interaction.user.username;
      await interaction.reply({
        content:
          `Paired **${result.address}** to your Discord account.\n${next}`,
        flags: MessageFlags.Ephemeral,
      });
      if (registry.spectrumHandle?.app) {
        const { sendSpectrumText } = await import("../spectrum/outbound.js");
        void sendSpectrumText(
          registry.spectrumHandle.app,
          result.address,
          formatPairingCompleteMessage(discordName),
        )
          .then((notify) => {
            if (notify.ok) return;
            console.error(`[spectrum] pairing notify failed: ${notify.error}`);
            return interaction
              .followUp({
                content:
                  `⚠️ Pairing succeeded, but SMS confirmation failed (${notify.error}). ` +
                  `You can still text Punch from **${result.address}**.`,
                flags: MessageFlags.Ephemeral,
              })
              .catch((err) => {
                console.error(`[spectrum] pairing notify follow-up failed: ${err.message}`);
              });
          })
          .catch((err) => {
            console.error(`[spectrum] pairing notify failed: ${err.message}`);
            interaction
              .followUp({
                content:
                  `⚠️ Pairing succeeded, but SMS confirmation failed. ` +
                  `You can still text Punch from **${result.address}**.`,
                flags: MessageFlags.Ephemeral,
              })
              .catch(() => {});
          });
      }
      return;
    }

    if (interaction.commandName === "unpair") {
      const phone = interaction.options.getString("phone");
      const { unpairUser } = await import("../spectrum/pairing.js");
      const result = unpairUser(interaction.user.id, phone);
      if (!result.ok) {
        await interaction.reply({ content: `⚠️ ${result.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      const list = result.addresses.map((a) => `\`${a}\``).join(", ");
      await interaction.reply({
        content: `Unpaired ${list} from your Discord account. Text Punch again to get a new pairing code.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "sandbox") {
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const users = sandbox.loadUsers();
        if (users.length === 0) {
          await interaction.reply({ content: "No dynamic sandbox users configured. Use `/sandbox create` to add one.", flags: MessageFlags.Ephemeral });
          return;
        }
        const lines = users.map((u, i) => `${i + 1}. **${u.name}** — \`${u.userId}\``);
        await interaction.reply({ content: `**Sandbox users:**\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "create") {
        const name = interaction.options.getString("name", true).toLowerCase().replace(/[^a-z0-9-]/g, "");
        const userId = interaction.options.getString("userid") || interaction.user.id;

        if (!name) {
          await interaction.reply({ content: "Name must contain only lowercase letters, digits, and hyphens.", flags: MessageFlags.Ephemeral });
          return;
        }

        const add = sandbox.addUser(name, userId);
        if (!add.ok) {
          await interaction.reply({ content: `⚠️ ${add.error}`, flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.reply({ content: `Creating sandbox for **${name}** (\`${userId}\`)…`, flags: MessageFlags.Ephemeral });

        const up = await sandbox.composeUp(name);
        if (!up.ok) {
          sandbox.removeUser(name);
          const err = up.error.length > 1500 ? up.error.slice(0, 1500) + "..." : up.error;
          await interaction.editReply({ content: `⚠️ Failed to create sandbox: ${err}` });
          return;
        }

        reloadSandboxMap();
        await interaction.editReply({ content: `✅ Sandbox **${name}** created and running!` });
        return;
      }

      if (sub === "remove") {
        const name = interaction.options.getString("name", true).toLowerCase();

        const down = await sandbox.composeDown(name);
        if (!down.ok) {
          await interaction.reply({ content: `⚠️ Failed to remove sandbox container: ${down.error}`, flags: MessageFlags.Ephemeral });
          return;
        }

        const del = sandbox.removeUser(name);
        if (!del.ok) {
          await interaction.reply({ content: `⚠️ ${del.error}`, flags: MessageFlags.Ephemeral });
          return;
        }

        reloadSandboxMap();
        await interaction.reply({ content: `✅ Sandbox **${name}** removed.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "restart-all") {
        if (!isBotOwner(interaction.user.id)) {
          await interaction.reply({ content: "⛔ Only the bot owner can restart sandboxes.", flags: MessageFlags.Ephemeral });
          return;
        }
        const users = sandbox.loadUsers();
        if (users.length === 0) {
          await interaction.reply({ content: "No dynamic sandbox users configured. Use `/sandbox create` to add one.", flags: MessageFlags.Ephemeral });
          return;
        }
        const noun = users.length === 1 ? "sandbox" : "sandboxes";
        const recreate = interaction.options.getBoolean("recreate") ?? false;
        await interaction.reply({
          content: recreate
            ? `Recreating ${users.length} ${noun} from the current image — volumes kept…`
            : `Restarting ${users.length} ${noun} — volumes kept…`,
          flags: MessageFlags.Ephemeral,
        });

        const res = await sandbox.restartAllSandboxes({ recreate });
        reloadSandboxMap();

        const lines = res.results.map((r) =>
          `${r.ok ? "✅" : "⚠️"} **${r.name}**${r.ok ? "" : ` — ${(r.error || "").slice(0, 300)}`}`,
        ).join("\n");
        const okLabel = res.ok ? "✅" : "⚠️";
        const okText = res.ok
          ? (recreate ? "All sandboxes recreated" : "All sandboxes restarted")
          : (recreate ? "Some sandboxes failed to recreate" : "Some sandboxes failed to restart");
        await interaction.editReply({
          content: `${okLabel} ${okText}. User data volumes were preserved.\n${lines}`,
        });
        return;
      }
    }

    if (interaction.commandName === "collab") {
      const sub = interaction.options.getSubcommand();
      const owner = sandboxNameForUser(interaction.user.id);
      if (!owner) {
        await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        if (sub === "status") {
          const records = collabs.listFor(owner);
          const text = records.length
            ? records.map((record) => {
                const proposal = record.proposal;
                return `**${record.id}** with **${record.participants.find((name) => name !== owner)}**\nmain: \`${record.base.slice(0, 12)}\`${proposal ? ` · ${proposal.status} · ${proposal.head.slice(0, 12)}` : " · no proposal"}`;
              }).join("\n")
            : "No collaborations.";
          await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
          return;
        }
        const reviewer = interaction.options.getString("reviewer", true).toLowerCase();
        const workspace = interaction.options.getString("workspace", true);
        const task = sub === "start" ? interaction.options.getString("task", true) : "";
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const collab = await collabs.create({ owner, reviewer, workspace });
        if (task) {
          const reviewerId = sandbox.loadUsers().find((user) => user.name === reviewer)?.userId;
          if (reviewerId) {
            handleAgentPigeon(reviewerId, owner, `Collaboration ${collab.id} started. Your clone is ${collab.workspaces[reviewer]}. ${task}`, 0).catch(() => {});
          }
        }
        await interaction.editReply({ content: `Collaboration **${collab.id}** ready. **${reviewer}** cloned at \`${collab.workspaces[reviewer]}\`. Both agents must use the \`collab\` tool; matching approvals auto-merge into \`main\`.` });
      } catch (error) {
        await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral }).catch(async () => interaction.editReply({ content: `⚠️ ${error.message}` }));
      }
      return;
    }

    if (interaction.commandName === "skills") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      const url = apiUrlFor(uid);
      const auth = supervisorAuth();
      if (!url) {
        await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        if (sub === "list" || sub === "proposals") {
          const endpoint = sub === "list" ? "/skills" : "/skills/proposals";
          const res = await fetch(`${url}${endpoint}`, { headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const data = await res.json();
          const entries = sub === "list" ? data.skills : data.proposals;
          const body = !entries?.length ? (sub === "list" ? "No instruction skills installed." : "No skill proposals pending review.") : sub === "list"
            ? `**Skills** (Pi lists enabled skills; the agent reads relevant skills on demand):\n${entries.map((skill) => `${skill.enabled ? "✅" : "⏸️"} **${skill.name}** (${skill.source})${skill.description ? ` — ${skill.description}` : ""}${skill.requirements?.missingEnv?.length || skill.requirements?.missingBinaries?.length ? ` [missing: ${[...(skill.requirements?.missingEnv || []), ...(skill.requirements?.missingBinaries || [])].join(", ")}]` : ""}`).join("\n")}`
            : `**Pending skill proposals:**\n${entries.map((proposal) => `\`${proposal.id}\` **${proposal.name}** (${proposal.size}B)`).join("\n")}`;
          await interaction.reply({ content: body.slice(0, 1_900), flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === "approve" || sub === "reject") {
          const id = interaction.options.getString("id", true);
          const res = await fetch(`${url}/skills/proposals/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ approve: sub === "approve" }) });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { result } = await res.json();
          await interaction.reply({ content: result.approved ? `Installed skill \`${result.name}\`. Pi discovers it when loading a session or reloading resources; the agent decides when to read it.` : `Rejected skill proposal \`${result.name}\`.`, flags: MessageFlags.Ephemeral });
          return;
        }
        const name = interaction.options.getString("name", true);
        if (sub === "inspect") {
          const res = await fetch(`${url}/skills/${encodeURIComponent(name)}`, { headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { skill } = await res.json();
          await interaction.reply({ content: `**${skill.name}** (${skill.source}, ${skill.enabled ? "enabled" : "disabled"})\nPi lists enabled skills by description; the agent reads the full instructions when relevant.\n\`\`\`\n${skill.content.slice(0, 1_500)}\n\`\`\``, flags: MessageFlags.Ephemeral });
          return;
        }
        const res = await fetch(`${url}/skills/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ enabled: sub === "enable" }) });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        await interaction.reply({
          content: sub === "enable"
            ? `Enabled skill \`${name}\`. Pi makes it available when loading a session or reloading resources; the agent decides when to read it.`
            : `Disabled skill \`${name}\`. Pi removes it from discovery when loading a session or reloading resources.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "extensions") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      const url = apiUrlFor(uid);
      const auth = supervisorAuth();
      if (!url) {
        await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        if (sub === "list") {
          const res = await fetch(`${url}/extensions`, { headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { extensions } = await res.json();
          if (!extensions?.length) {
            await interaction.reply({ content: "No extensions found.", flags: MessageFlags.Ephemeral });
            return;
          }
          const body = `**Pi extensions:**\n${extensions.map((ext) => {
            const icon = ext.quarantined ? "🔴" : ext.disabled ? "⏸️" : "✅";
            const size = ext.size > 1024 ? `${(ext.size / 1024).toFixed(1)}KB` : `${ext.size}B`;
            return `${icon} **${ext.name}** (${size})`;
          }).join("\n")}`;
          await interaction.reply({ content: body.slice(0, 1_900), flags: MessageFlags.Ephemeral });
          return;
        }
        const name = interaction.options.getString("name", true);
        if (sub === "disable") {
          const res = await fetch(`${url}/extensions/disable`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ name }) });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          await interaction.reply({ content: `Disabled extension \`${name}\`. Pi will restart without it.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === "enable") {
          const res = await fetch(`${url}/extensions/enable`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ name }) });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          await interaction.reply({ content: `Enabled extension \`${name}\`. Pi will restart with it.`, flags: MessageFlags.Ephemeral });
          return;
        }
      } catch (error) {
        await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "workers") {
      const uid = interaction.user.id;
      const url = apiUrlFor(uid);
      const auth = supervisorAuth();
      if (!url) { await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral }); return; }
      const sub = interaction.options.getSubcommand();
      try {
        await syncWorkerCap(uid);
        if (sub === "list") {
          const res = await fetch(`${url}/workers`, { headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { workers } = await res.json();
          const settings = await getWorkerSettings(uid);
          const header = settings ? `**Workers** (${settings.active}/${settings.cap} active):\n` : "**Workers:**\n";
          const body = workers?.length ? `${header}${workers.slice(0, 15).map((worker) => `\`${worker.id.slice(0, 8)}\` ${worker.kind} **${worker.status}** — ${new Date(worker.createdAt).toLocaleString()}`).join("\n")}` : `${header.trim()} No workers.`;
          await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === "cap") {
          const value = interaction.options.getInteger("value");
          if (value != null) store.patchUserSettings(uid, { multitaskWorkersCap: value });
          const settings = await syncWorkerCap(uid);
          if (!settings) {
            await interaction.reply({ content: "This sandbox predates worker caps. Recreate it to use `/workers cap`.", flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.reply({
            content: `${value != null ? "Worker cap set. " : ""}**Workers:** ${settings.active}/${settings.cap} active (${settings.available} slots free).`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const id = interaction.options.getString("id", sub !== "start");
        if (sub === "logs") {
          const res = await fetch(`${url}/workers/${encodeURIComponent(id)}/logs`, { headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { record, log } = await res.json();
          await interaction.reply({ content: `**${record.kind}** \`${record.id}\` (${record.status})\n\`\`\`\n${(log || "(no log yet)").slice(-1_650)}\n\`\`\``, flags: MessageFlags.Ephemeral });
          return;
        }
        if (sub === "stop") {
          const res = await fetch(`${url}/workers/${encodeURIComponent(id)}/stop`, { method: "POST", headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          await interaction.reply({ content: `Stopping worker \`${id}\`.`, flags: MessageFlags.Ephemeral });
          return;
        }
        const timeoutMinutes = Math.max(1, Math.min(30, interaction.options.getInteger("timeout_minutes") || 10));
        const res = await fetch(`${url}/workers`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ kind: interaction.options.getString("kind", true), prompt: interaction.options.getString("prompt", true), model: interaction.options.getString("model") || undefined, timeoutMs: timeoutMinutes * 60_000 }) });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { worker } = await res.json();
        await interaction.reply({ content: `Started isolated ${worker.kind} worker \`${worker.id}\`. Result will arrive in DM.`, flags: MessageFlags.Ephemeral });
      } catch (error) { await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    if (interaction.commandName === "models") {
      const uid = interaction.user.id;
      if (!apiUrlFor(uid)) { await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral }); return; }
      try {
        const { model, thinkingLevel } = await modelsSupervisor(uid, "/model");
        const expiresAt = Date.now() + MODELS_MENU_TTL_MS;
        await interaction.reply({ ...renderModelsMenu({ model, thinkingLevel, expiresAt }), flags: MessageFlags.Ephemeral });
        setTimeout(() => {
          interaction.editReply({ content: MODELS_MENU_EXPIRED, components: [] }).catch(() => {});
        }, MODELS_MENU_TTL_MS).unref();
      } catch (err) {
        await interaction.reply({ content: `⚠️ Error fetching model: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "apikey") {
      const uid = interaction.user.id;
      const apiUrl = apiUrlFor(uid);
      const auth = supervisorAuth();
      const provider = interaction.options.getString("provider", true).toLowerCase();
      const key = interaction.options.getString("key");
      if (!PROVIDER_NAMES.includes(provider)) {
        const provRes = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
        if (provRes.ok) {
          const { providers = [] } = await provRes.json();
          if (!providers.includes(provider)) {
            await interaction.reply({ content: `⚠️ Unknown provider \`${provider}\`. Use \`/provider add\` to register custom providers, or choose: ${PROVIDER_NAMES.join(", ")}`, flags: MessageFlags.Ephemeral });
            return;
          }
        } else {
          await interaction.reply({ content: `⚠️ Unknown provider \`${provider}\`. Valid: ${PROVIDER_NAMES.join(", ")}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      try {
        const res = await fetch(`${apiUrl}/apikey`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ provider, key: key || null }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `supervisor API ${res.status}`);
        }
        await interaction.reply({
          content: key ? `✅ API key set for **${provider}**. Restarting sandbox LLM process…` : `✅ API key removed for **${provider}**. Restarting sandbox LLM process…`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "provider") {
      const uid = interaction.user.id;
      const apiUrl = apiUrlFor(uid);
      const auth = supervisorAuth();
      const sub = interaction.options.getSubcommand();
      // `/provider model add` also reports sub "add"; check the group first.
      const group = interaction.options.getSubcommandGroup();

      if (!group && sub === "add") {
        const name = interaction.options.getString("name", true).toLowerCase().replace(/[^a-z0-9_-]/g, "");
        const endpoint = interaction.options.getString("endpoint", true);
        const api = interaction.options.getString("api") || "openai-completions";
        try {
          const res = await fetch(`${apiUrl}/provider`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ name, endpoint, api }),
          });
          if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
          await interaction.reply({
            content: `✅ Custom provider **${name}** created.\nEndpoint: \`${endpoint}\`\n\nAdd models with: \`/provider model add ${name} <model-id>\``,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (!group && sub === "edit") {
        const name = interaction.options.getString("name", true).toLowerCase();
        const endpoint = interaction.options.getString("endpoint") || undefined;
        const api = interaction.options.getString("api") || undefined;
        if (!endpoint && !api) {
          await interaction.reply({ content: "⚠️ Provide at least one field to update (endpoint or api).", flags: MessageFlags.Ephemeral });
          return;
        }
        try {
          const res = await fetch(`${apiUrl}/provider`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ name, endpoint, api }),
          });
          if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
          await interaction.reply({ content: `✅ Provider **${name}** updated.`, flags: MessageFlags.Ephemeral });
        } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (!group && sub === "remove") {
        const name = interaction.options.getString("name", true).toLowerCase();
        try {
          const res = await fetch(`${apiUrl}/provider`, {
            method: "DELETE",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
          await interaction.reply({ content: `✅ Provider **${name}** removed.`, flags: MessageFlags.Ephemeral });
        } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (!group && sub === "list") {
        try {
          const res = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { providers = [], custom = {} } = await res.json();
          const lines = providers.map(p => {
            const cfg = custom[p];
            if (!cfg) return `• **${p}** (built-in)`;
            const modelCount = (cfg.models || []).length;
            return `• **${p}** — \`${cfg.baseUrl}\` (${modelCount} model${modelCount === 1 ? "" : "s"})`;
          });
          await interaction.reply({
            content: `**Available providers:**\n${lines.length ? lines.join("\n") : "No providers found."}`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (group === "model") {
        if (sub === "add") {
          const provider = interaction.options.getString("provider", true).toLowerCase();
          const model = interaction.options.getString("model", true);
          const name = interaction.options.getString("name") || undefined;
          const context = interaction.options.getInteger("context") ?? undefined;
          const maxTokens = interaction.options.getInteger("max_tokens") ?? undefined;
          const reasoning = interaction.options.getBoolean("reasoning") ?? undefined;
          try {
            const res = await fetch(`${apiUrl}/provider/model`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: auth },
              body: JSON.stringify({ provider, model, name, context, maxTokens, reasoning }),
            });
            if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
            await interaction.reply({
              content: `✅ Model **${model}** added to **${provider}**.\nProperties: ${name ? `"${name}"` : model} | ${context ?? 128000} ctx | ${maxTokens ?? 4096} max${reasoning ? " | reasoning" : ""}`,
              flags: MessageFlags.Ephemeral,
            });
          } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
          return;
        }

        if (sub === "edit") {
          const provider = interaction.options.getString("provider", true).toLowerCase();
          const model = interaction.options.getString("model", true);
          try {
            const provRes = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
            const { custom = {} } = await provRes.json();
            const cfg = custom[provider];
            if (!cfg) { await interaction.reply({ content: `⚠️ Provider **${provider}** not found.`, flags: MessageFlags.Ephemeral }); return; }
            const modelEntry = (cfg.models || []).find(m => m.id === model);
            if (!modelEntry) { await interaction.reply({ content: `⚠️ Model **${model}** not found on **${provider}**.`, flags: MessageFlags.Ephemeral }); return; }

            const modal = new ModalBuilder()
              .setCustomId(`model_edit_modal:${provider}:${model}`)
              .setTitle(`Edit: ${provider}/${model}`);

            const nameInput = new TextInputBuilder()
              .setCustomId("edit_name")
              .setLabel("Display name")
              .setStyle(TextInputStyle.Short)
              .setValue(modelEntry.name || "")
              .setRequired(false)
              .setMaxLength(100);

            const ctxInput = new TextInputBuilder()
              .setCustomId("edit_context")
              .setLabel("Context window (number)")
              .setStyle(TextInputStyle.Short)
              .setValue(String(modelEntry.contextWindow ?? ""))
              .setRequired(false)
              .setMaxLength(10);

            const mtInput = new TextInputBuilder()
              .setCustomId("edit_maxTokens")
              .setLabel("Max tokens (number)")
              .setStyle(TextInputStyle.Short)
              .setValue(String(modelEntry.maxTokens ?? ""))
              .setRequired(false)
              .setMaxLength(10);

            const reasonInput = new TextInputBuilder()
              .setCustomId("edit_reasoning")
              .setLabel("Reasoning (yes/no)")
              .setStyle(TextInputStyle.Short)
              .setValue(modelEntry.reasoning ? "yes" : "no")
              .setRequired(false)
              .setMaxLength(3);

            await interaction.showModal(modal.addComponents(
              new ActionRowBuilder().addComponents(nameInput),
              new ActionRowBuilder().addComponents(ctxInput),
              new ActionRowBuilder().addComponents(mtInput),
              new ActionRowBuilder().addComponents(reasonInput),
            ));
          } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
          return;
        }

        if (sub === "remove") {
          const provider = interaction.options.getString("provider", true).toLowerCase();
          const model = interaction.options.getString("model", true);
          try {
            const res = await fetch(`${apiUrl}/provider/model`, {
              method: "DELETE",
              headers: { "content-type": "application/json", authorization: auth },
              body: JSON.stringify({ provider, model }),
            });
            if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
            await interaction.reply({ content: `✅ Model **${model}** removed from **${provider}**.`, flags: MessageFlags.Ephemeral });
          } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
          return;
        }

        if (sub === "list") {
          const provider = interaction.options.getString("provider", true).toLowerCase();
          try {
            const res = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
            const { custom = {} } = await res.json();
            const cfg = custom[provider];
            if (!cfg) { await interaction.reply({ content: `⚠️ Provider **${provider}** not found.`, flags: MessageFlags.Ephemeral }); return; }
            const models = cfg.models || [];
            if (!models.length) {
              await interaction.reply({ content: `No models for **${provider}**. Add one: \`/provider model add ${provider} <model-id>\``, flags: MessageFlags.Ephemeral });
              return;
            }
            const lines = models.map(m => {
              const parts = [`• \`${m.id}\``];
              if (m.name && m.name !== m.id) parts.push(`— ${m.name}`);
              parts.push(`(${m.contextWindow ?? "?"} ctx, ${m.maxTokens ?? "?"} max${m.reasoning ? ", reasoning" : ""})`);
              return parts.join(" ");
            });
            await interaction.reply({ content: `**Models for ${provider}:**\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral });
          } catch (err) { await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
          return;
        }
      }

      await interaction.reply({ content: "⚠️ Unknown subcommand.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "settings") {
      try {
        await settings.handleSettingsSlash(interaction, settingsDeps());
      } catch (err) {
        const replied = interaction.replied || interaction.deferred;
        const payload = { content: `⚠️ ${err.message}` };
        if (replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
      return;
    }

    if (interaction.commandName === "trigger") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      try {
        if (sub === "set") {
          const word = interaction.options.getString("word", true).toLowerCase();
          await interaction.reply({ content: settings.setUserTriggerWord(uid, word) });
        } else {
          await interaction.reply({ content: settings.setUserTriggerWord(uid, null) });
        }
      } catch (err) {
        await interaction.reply({ content: `⚠️ ${err.message}` });
      }
      return;
    }

    if (interaction.commandName === "routine") {
      const sub = interaction.options.getSubcommand();
      const ctx = routineContextFromInteraction(interaction);

      if (sub === "add") {
        const type = interaction.options.getString("type", true);
        const when = interaction.options.getString("when", true);
        const text = interaction.options.getString("text", true);
        const recurrence = interaction.options.getString("recurrence") || "once";
        try {
          const userZone = userTimeZone(ctx.userId);
          const timezone = interaction.options.getString("timezone") || userZone;
          const activeStart = interaction.options.getInteger("active_start");
          const activeEnd = interaction.options.getInteger("active_end");
          const activeHours = activeStart === null || activeEnd === null ? null : { start: activeStart, end: activeEnd, timezone };
          const schedule = routines.parseRecurrence(when, recurrence, timezone);
          const routine = routines.addRoutine({
            ...ctx,
            channelId: type === "heartbeat" ? null : ctx.channelId,
            type, payload: text, schedule, timezone, activeHours,
            isolatedSession: interaction.options.getBoolean("isolated_session") || false,
          });
          const label = type === "heartbeat" ? "💓 Heartbeat" : "⏰ Scheduled";
          const note = type === "heartbeat" ? "\nI'll DM you the results each time." : "";
          const whenLabel = formatInTimeZone(routine.nextRunAt, routine.timezone || timezone) || new Date(routine.nextRunAt).toISOString();
          await interaction.reply({
            content: `${label} (\`${routine.id}\`) — fires ${whenLabel}${note}`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) {
          await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (sub === "history") {
        const id = interaction.options.getString("id") || null;
        const entries = routines.listHistory(ctx.userId, id, 20);
        const body = entries.length
          ? `**Routine history:**\n${entries.map((entry) => `${entry.status === "succeeded" ? "✅" : entry.status === "failed" ? "❌" : "⏳"} \`${entry.routineId}\` attempt ${entry.attempt} ${new Date(entry.startedAt).toLocaleString()}${entry.error ? ` — ${entry.error.slice(0, 180)}` : ""}`).join("\n")}`
          : "No routine history.";
        await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "remove") {
        const id = interaction.options.getString("id", true);
        const ok = routines.removeRoutine(id, ctx.userId);
        await interaction.reply({
          content: ok ? `Removed routine \`${id}\`.` : `No routine \`${id}\` found.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "pause" || sub === "resume") {
        const id = interaction.options.getString("id", true);
        const r = routines.setRoutineEnabled(id, ctx.userId, sub === "resume");
        await interaction.reply({
          content: r ? `${sub === "pause" ? "Paused" : "Resumed"} routine \`${id}\`.` : `No routine \`${id}\` found.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.commandName === "timeout") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      if (sub === "disable") {
        store.patchUserSettings(uid, { disableIdleTimeout: true });
        await interaction.reply({ content: "⏱️ Idle/stale timeouts disabled — hung turns won't be aborted for silence or heartbeat-only working (the hard ceiling still applies).", flags: MessageFlags.Ephemeral });
      } else if (sub === "enable") {
        store.patchUserSettings(uid, { disableIdleTimeout: false });
        await interaction.reply({ content: "⏱️ Idle/stale timeouts re-enabled (90s silence / ~3m stuck tool-or-working).", flags: MessageFlags.Ephemeral });
      } else {
        const us = store.getUserSettings(uid);
        await interaction.reply({ content: `⏱️ Idle/stale timeouts are currently **${us.disableIdleTimeout ? "disabled" : "enabled (90s silence / ~3m stuck working)"}**.`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "botmode") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;

      if (sub === "auto-compress") {
        const threshold = interaction.options.getInteger("threshold");
        if (threshold != null) {
          try {
            validateAutoCompressThreshold(threshold);
          } catch (error) {
            await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral });
            return;
          }
          store.patchUserSettings(uid, { autoCompressThreshold: threshold });
          const msg = threshold === 0 ? "Automatic context-pruning prompt disabled." : `Context-pruning prompt threshold set to **${threshold}%**.`;
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        } else {
          const us = store.getUserSettings(uid);
          const msg = us.autoCompressThreshold === 0 ? "Automatic context-pruning prompt **disabled**." : `Context-pruning prompt threshold: **${us.autoCompressThreshold}%**.`;
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
        return;
      }

      const state = interaction.options.getString("state", true);
      const key = sub === "allow-bots" ? "allowBots" : sub === "show-context" ? "showContext" : sub === "git-co-author" ? "gitCoAuthor" : "noThinking";
      const label = sub === "allow-bots" ? "Bot messages triggering Punch" : sub === "show-context" ? "Always-on context indicator" : sub === "git-co-author" ? "Co-Authored-By trailer in commits" : "Thinking message";
      if (state === "status") {
        const us = store.getUserSettings(uid);
        await interaction.reply({ content: `${label} is currently **${us[key] ? "ON" : "off"}**.`, flags: MessageFlags.Ephemeral });
      } else {
        store.patchUserSettings(uid, { [key]: state === "on" });
        await interaction.reply({ content: `${label} **${state === "on" ? "enabled" : "disabled"}**.`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "remind") {
      const when = interaction.options.getString("when", true);
      const message = interaction.options.getString("message", true);
      const ctx = routineContextFromInteraction(interaction);
      try {
        const zone = userTimeZone(ctx.userId);
        const routine = routines.addRoutine({
          ...ctx,
          type: "message",
          payload: message,
          timezone: zone,
          schedule: { kind: "once", at: routines.parseTime(when, new Date(), zone) },
        });
        const whenLabel = formatInTimeZone(routine.nextRunAt, zone) || new Date(routine.nextRunAt).toISOString();
        await interaction.reply({
          content: `⏰ Scheduled (\`${routine.id}\`) — fires ${whenLabel}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.commandName === "logs") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;

      if (!apiUrlFor(uid)) {
        await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "status") {
        try {
          const body = logs.fetchLogStatus(uid);
          await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
        } catch (err) {
          await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
        }
        return;
      }

      const source = interaction.options.getString("source") || "all";
      const lines = Math.min(100, interaction.options.getInteger("lines") || 30);
      await interaction.reply({ content: "Fetching logs…", flags: MessageFlags.Ephemeral });
      try {
        await sendLogReply(interaction, uid, { source, lines });
      } catch (err) {
        await interaction.editReply({ content: `⚠️ ${err.message}` });
      }
      return;
    }

    if (interaction.commandName === "reset") {
      await withUserRunLock(interaction.user.id, () => store.clearSession(interaction.channelId));
      await interaction.reply({
        content: "Fresh session. Prior context dropped.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "compress") {
      const uid = interaction.user.id;
      const cid = interaction.channelId;
      if (!store.getSession(cid)) {
        await interaction.reply({
          content: "Nothing to compress yet — there's no active conversation in this channel. Send a message first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!apiUrlFor(uid)) {
        await interaction.reply({
          content: "You don't have a sandbox assigned, so there's no conversation to compress.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: `🔄 Compressing conversation…\n${progressBar(0)} 0%`,
        flags: MessageFlags.Ephemeral,
      });

      const start = Date.now();
      let progress = 0;
      const iv = setInterval(async () => {
        const elapsed = (Date.now() - start) / 1000;
        // Ease toward 95% while the server works; jumps to 100% on completion.
        // Slower ramp so the bar doesn't parking at the top for large sessions.
        const target = Math.min(95, (elapsed / 90) * 95);
        progress = Math.max(progress, target);
        const pct = Math.round(progress);
        await interaction.editReply(`🔄 Compressing conversation…\n${progressBar(pct)} ${pct}%`).catch(() => {});
      }, 1500);

      // Summarizing a long session can take well over the default per-turn HTTP
      // timeout (PI_TIMEOUT), so give it a dedicated, generous budget.
      const COMPRESS_TIMEOUT_MS = (Number(process.env.PI_COMPRESS_TIMEOUT) || 300) * 1000;
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), COMPRESS_TIMEOUT_MS);

      try {
        await withUserRunLock(uid, async () => {
          const currentSession = store.getSession(cid);
          if (!currentSession) throw new Error("Conversation reset before compression started.");
          await summarizeSession(currentSession, uid, ac.signal);
          store.clearMemoryRecall(currentSession);
        });
        clearInterval(iv);
        clearTimeout(to);
        await interaction.editReply(`✅ Conversation compressed.\n${progressBar(100)} 100%\nContext trimmed — fresh headspace for the next turn.`);
      } catch (err) {
        clearInterval(iv);
        clearTimeout(to);
        const msg = ac.signal.aborted
          ? `compression took longer than ${COMPRESS_TIMEOUT_MS / 1000}s — the session may be very large. Try again, or start fresh with a new session.`
          : err.message;
        await interaction.editReply(`⚠️ Compression failed: ${msg}`).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === "heartbeat") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      const cid = interaction.channelId;

      if (sub === "add") {
        const when = interaction.options.getString("when", true);
        const prompt = interaction.options.getString("prompt", true);
        try {
          const zone = userTimeZone(uid);
          const schedule = routines.parseRecurrence(when, "once", zone);
          const routine = routines.addRoutine({
            userId: uid, channelId: null, guildId: interaction.guild?.id || null,
            type: "heartbeat", payload: prompt, schedule, timezone: zone,
          });
          const whenLabel = formatInTimeZone(routine.nextRunAt, zone) || new Date(routine.nextRunAt).toISOString();
          await interaction.reply({
            content: `💓 Heartbeat scheduled (\`${routine.id}\`) — fires ${whenLabel}\nI'll DM you the results each time.`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) {
          await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (sub === "list") {
        const list = routines.listRoutines(uid).filter((r) => r.type === "heartbeat");
        const body = list.length === 0
          ? "No heartbeat automations scheduled."
          : `**Your heartbeats (${list.length}):**\n${list.map(routines.formatRoutine).join("\n")}`;
        await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "remove") {
        const id = interaction.options.getString("id", true);
        const ok = routines.removeRoutine(id, uid);
        await interaction.reply({
          content: ok ? `Removed heartbeat \`${id}\`.` : `No heartbeat \`${id}\` found.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "pause" || sub === "resume") {
        const id = interaction.options.getString("id", true);
        const r = routines.setRoutineEnabled(id, uid, sub === "resume");
        await interaction.reply({
          content: r ? `${sub === "pause" ? "Paused" : "Resumed"} heartbeat \`${id}\`.` : `No heartbeat \`${id}\` found.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "history") {
        const activities = state.getActivities(uid, { type: "heartbeat", limit: 10 });
        if (activities.length === 0) {
          await interaction.reply({ content: "No heartbeat activity yet.", flags: MessageFlags.Ephemeral });
          return;
        }
        const lines = activities.map((a) => {
          const t = new Date(a.ts).toLocaleString();
          const dur = `${(a.duration / 1000).toFixed(1)}s`;
          const status = a.status === "success" ? "✅" : "❌";
          const preview = a.response?.slice(0, 80) || "(no output)";
          return `${status} \`${t}\` ${dur} — ${preview}`;
        });
        await interaction.reply({
          content: `**Recent heartbeat activity:**\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.commandName === "mcp") {
      const uid = interaction.user.id;
      const url = apiUrlFor(uid);
      if (!url) {
        await interaction.reply({ content: "No sandbox assigned. Create one with `/sandbox create` first.", flags: MessageFlags.Ephemeral });
        return;
      }
      const auth = supervisorAuth();
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ ephemeral: true });
      try {
        if (sub === "auth") {
          const name = interaction.options.getString("name", true);
          const key = interaction.options.getString("key", true);
          const res = await fetch(`${url}/mcp/auth`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ name, key }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
          await interaction.editReply({
            content: `API key stored for MCP server \`${name}\`. Restarting Pi…`,
          });
          return;
        }
        if (sub === "logout") {
          const name = interaction.options.getString("name", true);
          const res = await fetch(`${url}/mcp/logout`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ name }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
          await interaction.editReply({
            content: `Removed stored API key for MCP server \`${name}\`. Restarting Pi…`,
          });
          return;
        }
        if (sub === "list") {
          const res = await fetch(`${url}/mcp`, { headers: { authorization: auth }, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`supervisor API ${res.status}`);
          const { mcp } = await res.json();
          const names = Object.keys(mcp || {});
          if (!names.length) {
            await interaction.editReply({ content: "No MCP servers configured. Add one with `/mcp add`." });
            return;
          }
          const lines = names.map((name) => {
            const e = mcp[name] || {};
            const on = e.enabled === false ? "⏸️" : "✅";
            const keyMark = e.apiKeyConfigured ? " 🔑" : "";
            if (e.type === "remote") return `${on} **${name}**${keyMark} (remote) \`${e.url || ""}\``;
            const cmd = Array.isArray(e.command) ? e.command.join(" ") : String(e.command || "");
            return `${on} **${name}**${keyMark} (local) \`${cmd}\``.slice(0, 200);
          });
          await interaction.editReply({ content: `**MCP servers:**\n${lines.join("\n")}`.slice(0, 1900) });
          return;
        }
        if (sub === "remove") {
          const name = interaction.options.getString("name", true);
          const res = await fetch(`${url}/mcp/remove`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ name }),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
          await interaction.editReply({ content: `Removed MCP server \`${name}\`. Restarting Pi…` });
          return;
        }
        if (sub === "add") {
          const name = interaction.options.getString("name", true);
          const type = interaction.options.getString("type", true);
          const mcpUrl = interaction.options.getString("url");
          const commandStr = interaction.options.getString("command");
          const apiKey = interaction.options.getString("key");
          const apiKeyEnv = interaction.options.getString("api_key_env");
          const apiKeyHeader = interaction.options.getString("api_key_header");
          const headersStr = interaction.options.getString("headers");
          const envStr = interaction.options.getString("environment");
          const payload = { name, type, enabled: true };
          if (apiKey) {
            payload.auth = "api_key";
            payload.apiKey = apiKey;
          }
          if (apiKeyEnv) payload.apiKeyEnv = apiKeyEnv;
          if (apiKeyHeader) payload.apiKeyHeader = apiKeyHeader;
          if (type === "remote") {
            if (!mcpUrl) throw new Error("Remote MCP requires `url`");
            payload.url = mcpUrl;
            if (headersStr) {
              let parsed;
              try { parsed = JSON.parse(headersStr); }
              catch { throw new Error("`headers` must be valid JSON object"); }
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("`headers` must be valid JSON object");
              }
              payload.headers = parsed;
            }
          } else if (type === "local") {
            if (!commandStr?.trim()) throw new Error("Local MCP requires `command`");
            // Simple argv split (supports "quoted" tokens). Same rules as docker/sandbox/usr/local/lib/mcp-config.mjs.
            const argv = [];
            let cur = "";
            let quote = null;
            const s = commandStr.trim();
            for (let i = 0; i < s.length; i++) {
              const ch = s[i];
              if (quote) {
                if (ch === quote) quote = null;
                else if (ch === "\\" && i + 1 < s.length) cur += s[++i];
                else cur += ch;
                continue;
              }
              if (ch === '"' || ch === "'") { quote = ch; continue; }
              if (/\s/.test(ch)) { if (cur) { argv.push(cur); cur = ""; } continue; }
              if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
              cur += ch;
            }
            if (quote) throw new Error("Unclosed quote in command");
            if (cur) argv.push(cur);
            if (!argv.length) throw new Error("Local MCP `command` is empty");
            payload.command = argv;
            if (envStr) {
              try { payload.environment = JSON.parse(envStr); }
              catch { throw new Error("`environment` must be valid JSON object"); }
            }
          } else {
            throw new Error("type must be local or remote");
          }
          const res = await fetch(`${url}/mcp/add`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
          await interaction.editReply({
            content: `Added MCP server \`${name}\` (${type}). Restarting Pi so the \`mcp\` tool can use it.`,
          });
          return;
        }
      } catch (err) {
        const message2 = err?.name === "TimeoutError" ? "Supervisor request timed out." : `Error: ${err.message}`;
        await interaction.editReply({ content: `⚠️ ${message2}` });
      }
      return;
    }

    if (interaction.commandName === "statistics") {
      await statistics.handleStatisticsCommand(interaction, statisticsExtrasForUser);
      return;
    }

    if (interaction.commandName === "tailscale") {
      const uid = interaction.user.id;
      const auth = supervisorAuth();
      const url = apiUrlFor(uid);
      if (!url) {
        await interaction.reply({ content: "No sandbox found. Create one with `/sandbox create` first.", flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = interaction.options.getSubcommand();
      try {
        if (sub === "key") {
          const authkey = interaction.options.getString("authkey", true);
          await interaction.deferReply({ ephemeral: true });
          const res = await fetch(`${url}/tailscale/key`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ key: authkey }),
          });
          const data = await res.json();
          if (data.success) await interaction.editReply("**Tailscale:** Connected.");
          else await interaction.editReply(`**Tailscale error:** ${data.error || "unknown"}`);
        } else if (sub === "login" || sub === "reauth") {
          await interaction.deferReply({ ephemeral: true });
          const res = await fetch(`${url}/tailscale/login`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ force: sub === "reauth" }),
          });
          const data = await res.json();
          if (data.url) {
            await interaction.editReply(
              `**Tailscale:** Open this link to authenticate your sandbox's device:\n${data.url}\n\nAfter approving, run \`/tailscale status\` to confirm.`,
            );
          } else {
            await interaction.editReply("**Tailscale:** Already authenticated (or no login URL emitted).");
          }
        } else if (sub === "status") {
          await interaction.deferReply({ ephemeral: true });
          const res = await fetch(`${url}/tailscale/status`, { headers: { authorization: auth } });
          const data = await res.json();
          if (data.error) {
            await interaction.editReply(`**Tailscale:** Not connected — ${data.error}`);
          } else {
            const self = data.Self || {};
            const peerCount = Object.keys(data.Peer || {}).length;
            const dnsName = self.DNSName || self.HostName || "unknown";
            await interaction.editReply(`**Tailscale:** Connected\n**Node:** ${dnsName}\n**Peers:** ${peerCount}`);
          }
        } else if (sub === "down") {
          await interaction.deferReply({ ephemeral: true });
          const res = await fetch(`${url}/tailscale/down`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (data.success) await interaction.editReply("**Tailscale:** Disconnected.");
          else await interaction.editReply(`**Tailscale error:** ${data.error || "unknown"}`);
        }
      } catch (err) {
        const message = `**Tailscale error:** ${err.message}`;
        if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
        else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === "env") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;

      if (sub === "set") {
        const key = interaction.options.getString("key", true);
        const value = interaction.options.getString("value", true);
        try {
          await setEnv(key, value, uid);
          await interaction.reply({ content: `✅ Environment variable \`${key}\` set.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
          await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
      } else if (sub === "list") {
        try {
          const { env } = await getEnv(uid);
          const keys = Object.keys(env || {});
          if (keys.length === 0) {
            await interaction.reply({ content: "No environment variables set.", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: `**Environment variables:**\n${keys.map(k => `\`${k}\``).join(", ")}`, flags: MessageFlags.Ephemeral });
          }
        } catch (err) {
          await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
      } else if (sub === "delete") {
        const key = interaction.options.getString("key", true);
        try {
          await setEnv(key, "", uid);
          await interaction.reply({ content: `✅ Environment variable \`${key}\` deleted.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
          await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
      }
      return;
    }

    if (interaction.commandName === "memory") {
      const sub = interaction.options.getSubcommand();
      const uid = interaction.user.id;
      const cid = interaction.channelId;
      const isDm = !interaction.guildId;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (sub === "export") {
        const bundle = await memoryReplyGuard(interaction, () => store.exportUserMemory(uid, { source: "punch" }));
        if (!bundle) return;
        const content = JSON.stringify(bundle, null, 2) + "\n";
        await interaction.editReply({
          content: `Exported ${bundle.records.length} durable user memory record(s). Channel memories and DM daily notes are excluded.`,
          files: [{ attachment: Buffer.from(content, "utf8"), name: "punch-memory-export.json" }],
        });
        return;
      }

      if (sub === "import") {
        const attachment = interaction.options.getAttachment("file", true);
        if (attachment.size > 1_000_000) {
          await interaction.editReply("Import file is too large (maximum 1 MB).");
          return;
        }
        if (!attachment.name?.toLowerCase().endsWith(".json")) {
          await interaction.editReply("Import must be a `.json` file created by `/memory export`.");
          return;
        }
        try {
          const response = await fetch(attachment.url);
          if (!response.ok) throw new Error(`Discord attachment fetch failed (${response.status})`);
          const raw = await response.text();
          if (raw.length > 1_000_000) throw new Error("Import file is too large");
          const stats = store.importUserMemory(uid, JSON.parse(raw), { source: "punch-import" });
          await interaction.editReply(`Imported ${stats.imported} record(s); skipped ${stats.skipped} duplicate, invalid, or sensitive record(s). Removed ${stats.removed} duplicate(s) during compaction.`);
        } catch (error) {
          await interaction.editReply(`Import failed: ${error.message}`);
        }
        return;
      }

      if (sub === "compact") {
        const stats = await memoryReplyGuard(interaction, () => store.compactMemory({ userId: uid, channelId: cid }));
        if (!stats) return;
        await interaction.editReply(`Memory compacted: ${stats.before} → ${stats.after}; removed ${stats.removed} duplicate(s).`);
        return;
      }

      if (sub === "view") {
        try {
          const file = await getFile("/work/.punch-memory.md", uid);
          const text = file.buffer.toString("utf8").slice(0, 1900);
          await interaction.editReply({ content: `**Project memory:**\n\n${text}` });
        } catch (err) {
          await interaction.editReply({ content: `⚠️ Could not read memory: ${err.message}` });
        }
        return;
      }

      const query = interaction.options.getString("query", true);
      const results = await memoryReplyGuard(interaction, () => (sub === "explain"
        ? store.explainMemory({ userId: uid, channelId: cid, query, isDm, limit: 10 })
        : store.searchMemory({ userId: uid, channelId: cid, query, isDm, limit: 10 })));
      if (!results) return;
      if (!results.length) {
        await interaction.editReply("No relevant memories found.");
        return;
      }
      const lines = results.map((item, index) => {
        const text = String(item.text).replace(/[`\r\n]+/g, " ").slice(0, 220);
        const detail = sub === "explain" ? ` — ${item.reason}` : "";
        return `${index + 1}. \`${item.citation}\` ${text}${detail}`;
      });
      let content = `**Memory ${sub}:**\n${lines.join("\n")}`;
      if (content.length > 1_900) content = `${content.slice(0, 1_899)}…`;
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }

    if (interaction.commandName === "doctor") {
      const requesterId = interaction.user.id;
      const requestedSandbox = interaction.options.getString("sandbox")?.toLowerCase() || null;
      const canManageServer = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === requesterId;
      if (requestedSandbox && !canManageServer) {
        await interaction.reply({ content: "Inspecting another sandbox requires Manage Server permission.", flags: MessageFlags.Ephemeral });
        return;
      }

      const users = sandbox.loadUsers();
      const mapping = requestedSandbox
        ? users.find((entry) => entry.name === requestedSandbox)
        : users.find((entry) => entry.userId === requesterId);
      if (!mapping) {
        await interaction.reply({ content: requestedSandbox ? `Sandbox **${requestedSandbox}** was not found.` : "No sandbox is mapped to your Discord account.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const apiUrl = apiUrlFor(mapping.userId);
      let gatewayUrl = null;
      if (apiUrl) {
        try {
          const parsed = new URL(apiUrl);
          parsed.port = "4096";
          gatewayUrl = parsed.toString().replace(/\/$/, "");
        } catch {
          gatewayUrl = apiUrl.replace(/:4097$/, ":4096");
        }
      }
      const diagnostics = await runDoctor({
        userId: mapping.userId,
        sandboxName: mapping.name,
        deep: interaction.options.getBoolean("deep") || false,
        sandbox,
        apiUrl,
        gatewayUrl,
        doctorToken: sandbox.doctorTokenFor(mapping.name),
        routines,
        memory: store,
      });

      const actions = new Map();
      const failedIds = new Set(diagnostics.checks.filter((item) => item.status === "fail").map((item) => item.id));
      const warningIds = new Set(diagnostics.checks.filter((item) => item.status === "warn").map((item) => item.id));
      if (failedIds.has("container")) actions.set("restart-container", ["Restart sandbox", ButtonStyle.Primary]);
      if (["gateway", "pi-process", "pi-health", "browser-extension"].some((id) => failedIds.has(id))) actions.set("restart-gateway", ["Restart Pi gateway", ButtonStyle.Primary]);
      if (["storage-access", "storage-write-probe"].some((id) => failedIds.has(id))) actions.set("repair-storage", ["Repair directories", ButtonStyle.Secondary]);
      if (failedIds.has("browser-probe")) actions.set("reset-browser", ["Reset browser profile", ButtonStyle.Danger]);
      if (warningIds.has("secret-permissions")) actions.set("repair-permissions", ["Tighten secret files", ButtonStyle.Secondary]);
      const components = actions.size
        ? [new ActionRowBuilder().addComponents(...[...actions].slice(0, 5).map(([action, [label, style]]) => {
            const token = createDoctorRepairToken(action, mapping.name, requesterId);
            return new ButtonBuilder().setCustomId(`docfix:${token}`).setLabel(label).setStyle(style);
          }))]
        : [];
      await interaction.editReply({ content: renderDoctorReport(diagnostics, mapping.name), components });
      return;
    }

  });

  // Handle skill removal
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== "skill_remove") return;
    const name = interaction.values[0];
    const uid = interaction.user.id;
    const auth = supervisorAuth();
    try {
      const res = await fetch(`${apiUrlFor(uid)}/tools/remove`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `supervisor API ${res.status}`);
      }
      await interaction.update({ content: `✅ Removed skill **${name}**. The sandbox supervisor will reload tools.`, components: [] });
    } catch (err) {
      await interaction.update({ content: `⚠️ Failed to remove skill: ${err.message}`, components: [] });
    }
  });

  // /models dropdowns (model + reasoning level). Each pick updates the menu in
  // place so it can be used again until it expires.
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const { base, expiresAt } = parseModelsMenuCustomId(interaction.customId);
    if (base !== MODEL_SELECT_ID && base !== THINKING_SELECT_ID) return;
    if (modelsMenuExpired(expiresAt)) {
      await interaction.update({ content: MODELS_MENU_EXPIRED, components: [] });
      return;
    }
    const value = interaction.values[0];
    const uid = interaction.user.id;

    if (base === MODEL_SELECT_ID && value === "__custom__") {
      try {
        const row = new ActionRowBuilder({
          components: [
            new TextInputBuilder()
              .setCustomId("model_name")
              .setLabel("Model identifier")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("provider/model-name (e.g. anthropic/claude-sonnet-4)")
              .setRequired(true),
          ],
        });
        const modal = new ModalBuilder()
          .setCustomId(modelsMenuCustomId(CUSTOM_MODEL_MODAL_ID, expiresAt))
          .setTitle("Set custom model")
          .addComponents(row);
        console.error("[model_select] showing modal...");
        await interaction.showModal(modal);
        console.error("[model_select] modal shown");
      } catch (err) {
        console.error("[model_select] showModal error:", err.message, err.stack?.split("\n")[1]);
        await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
        return;
      }
      return;
    }

    await interaction.deferUpdate();
    let notice;
    if (base === MODEL_SELECT_ID) {
      notice = await setModelNotice(uid, value);
    } else {
      try {
        const { thinkingLevel } = await modelsSupervisor(uid, "/model/thinking", { level: value });
        notice = `✅ Reasoning level set to **${thinkingLevelLabel(thinkingLevel)}**. Applies from your next message.`;
      } catch (err) {
        notice = err.status === 404
          ? "⚠️ This sandbox predates reasoning levels. Ask an admin to recreate it with `/sandbox restart-all recreate:true`."
          : `⚠️ Failed to set reasoning level: ${err.message}`;
      }
    }
    await interaction.editReply(await modelsMenuFor(uid, expiresAt, notice));
  });

  // Custom model modal (opened from the /models menu, which it then updates)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    const { base, expiresAt } = parseModelsMenuCustomId(interaction.customId);
    if (base !== CUSTOM_MODEL_MODAL_ID) return;
    const model = interaction.fields.getTextInputValue("model_name").trim();
    if (!model) {
      await interaction.reply({ content: "⚠️ Model name cannot be empty.", flags: MessageFlags.Ephemeral });
      return;
    }
    const uid = interaction.user.id;
    await interaction.deferUpdate();
    const notice = await setModelNotice(uid, model);
    await interaction.editReply(await modelsMenuFor(uid, expiresAt, notice));
  });

  // Handle model edit modal submission
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith("model_edit_modal:")) return;

    const parts = interaction.customId.split(":");
    if (parts.length < 3) { await interaction.reply({ content: "⚠️ Could not parse provider/model from modal.", flags: MessageFlags.Ephemeral }); return; }
    const provider = parts[1].toLowerCase();
    const model = parts.slice(2).join(":");

    const uid = interaction.user.id;
    const auth = supervisorAuth();
    const apiUrl = apiUrlFor(uid);

    const name = interaction.fields.getTextInputValue("edit_name").trim() || undefined;
    const contextRaw = interaction.fields.getTextInputValue("edit_context").trim();
    const maxTokensRaw = interaction.fields.getTextInputValue("edit_maxTokens").trim();
    const reasoningRaw = interaction.fields.getTextInputValue("edit_reasoning").trim().toLowerCase();

    const context = contextRaw ? parseInt(contextRaw, 10) : undefined;
    const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : undefined;
    const reasoning = reasoningRaw === "yes" || reasoningRaw === "true" || reasoningRaw === "y" || reasoningRaw === "1" ? true : reasoningRaw === "no" || reasoningRaw === "false" || reasoningRaw === "n" || reasoningRaw === "0" ? false : undefined;

    try {
      const res = await fetch(`${apiUrl}/provider/model`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ provider, model, name, context, maxTokens, reasoning }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
      await interaction.reply({
        content: `✅ Model **${model}** updated on **${provider}**.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await interaction.reply({ content: `⚠️ Failed to update model: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
  });
}
