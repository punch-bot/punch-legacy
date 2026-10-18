// Prefix ("!") command handling: !status, !help, !remember, !exec, !tasks, !remind,
// !routine, !logs, !setup, and friends. Wire-in: MessageCreate calls handleCommand
// when a prefixed command is recognized; returns true when handled.

import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import * as store from "../memory.js";
import * as sandbox from "../sandbox-manager.js";
import * as logs from "../logs.js";
import * as routines from "../routines.js";
import * as settings from "../settings.js";
import {
  getFile,
  execCommand,
  runBackgroundTask,
  listBackgroundTasks,
  killBackgroundTask,
  abortSession,
} from "../agent.js";
import { formatInTimeZone } from "../timezone.js";
import { PREFIX } from "../core/config.js";
import { registry } from "../core/registry.js";
import { reply } from "../core/discord.js";
import { activeStatusText } from "../chat/status.js";
import { settingsDeps } from "../chat/context.js";
import { withUserRunLock } from "../chat/queue.js";

function splitWhenAndText(rest, timeZone = null) {
  const words = rest.trim().split(/\s+/);
  if (words.length < 2) {
    throw new Error("Need a time and message, e.g. `30m take meds`");
  }
  for (let i = words.length - 1; i >= 1; i--) {
    const whenPart = words.slice(0, i).join(" ");
    const textPart = words.slice(i).join(" ");
    try {
      routines.parseTime(whenPart, new Date(), timeZone);
      return { when: whenPart, text: textPart };
    } catch {
      continue;
    }
  }
  throw new Error(`Could not parse time from: "${rest}"`);
}

function routineContextFromMessage(message) {
  return {
    userId: message.author.id,
    channelId: message.channelId,
    guildId: message.guild?.id || null,
  };
}

function routineContextFromInteraction(interaction) {
  return {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guild?.id || null,
  };
}

function userTimeZone(userId) {
  return store.getUserSettings(userId).timeZone || "UTC";
}

function statisticsExtrasForUser(userId) {
  const sandboxName = sandbox.loadUsers().find((entry) => entry.userId === userId)?.name || null;
  const activeRoutines = routines.listRoutines(userId).filter((routine) => routine.enabled !== false).length;
  const memoryRecords = store.list("user", userId).length;
  return { sandboxName, activeRoutines, memoryRecords };
}

async function createRoutineReply(message, opts) {
  const timezone = opts.timezone || userTimeZone(opts.userId || message.author.id);
  const routine = routines.addRoutine({ ...opts, timezone });
  const when = formatInTimeZone(routine.nextRunAt, routine.timezone || timezone) || new Date(routine.nextRunAt).toISOString();
  await reply(message, `⏰ Scheduled (\`${routine.id}\`) — fires ${when}`);
  return routine;
}

async function sendLogReply(target, userId, { source = "all", lines = 30 } = {}) {
  const result = await logs.fetchLogs(userId, { source, lines });
  const formatted = logs.formatLogReply(result.lines, result.title);
  const running = result.running ? "✅" : "❌";
  const prefix = `**${result.sandbox}** ${running}\n`;
  const payload = {
    content: prefix + formatted.content,
    files: formatted.truncated
      ? [{ attachment: Buffer.from(formatted.fullText, "utf8"), name: "logs.txt" }]
      : undefined,
  };
  if (target.editReply) {
    await target.editReply(payload);
  } else {
    await target.reply(payload);
  }
}

// Memory reads/writes raise MEMORY_UNAVAILABLE while the store is being repaired.
// Commands must answer the user instead of throwing out of the message handler.
async function withMemoryStore(message, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error?.code !== "MEMORY_UNAVAILABLE") throw error;
    await reply(message, "Memory is unavailable right now. Run `/doctor` and restore the store, then retry.");
    return { ok: false, value: null };
  }
}

async function handleCommand(message, cmd, rest) {
  const uid = message.author.id;
  const cid = message.channelId;

  switch (cmd) {
    case "status": {
      await reply(message, await activeStatusText(uid));
      return true;
    }
    case "help": {
      const embed = new EmbedBuilder()
        .setTitle("punch — Discord → Pi bridge")
        .setDescription("Mention me, DM me, or send a voice memo in a DM or as a reply to me in a server. Commands:")
        .addFields(
          { name: "Memory", value: `\`\`${PREFIX}remember <text>\`\` — save a fact about you\n\`\`${PREFIX}remember-channel <text>\`\` — save a fact for this channel\n\`\`${PREFIX}memories\`\` — list your + channel memories\n\`\`${PREFIX}forget <id>\`\` — delete a memory by id`, inline: true },
          { name: "Session", value: `\`\`${PREFIX}reset\`\` — start a fresh Pi session here`, inline: true },
          { name: "\u200B", value: "\u200B" },
          { name: "Background Tasks", value: `\`\`${PREFIX}status\`\` — show active turn + workers\n\`\`${PREFIX}stop\`\` — cancel all queued/in-flight requests\n\`/workers\` — isolated Pi background workers\n\`\`${PREFIX}exec <command>\`\` — run a command and get output\n\`\`${PREFIX}bg <command>\`\` — run a command in background\n\`\`${PREFIX}tasks\`\` — list processes (dropdown to kill)\n\`\`${PREFIX}task-log <filename>\`\` — view task log (last 20 lines)\n\`\`${PREFIX}logs [source] [lines]\`\` — sandbox / Pi gateway logs`, inline: true },
          { name: "\u200B", value: "\u200B" },
          { name: "Channel Settings", value: "`/settings` — summon word, channel lock, reaction summon, progress mode\n`/settings view` to see current values\n`!setup` / `!forget-channel` — channel lock aliases", inline: true },
          { name: "Routines", value: `\`\`${PREFIX}remind <when> <text>\`\` — one-shot reminder\n\`\`${PREFIX}routine list\`\` — list your routines\n\`\`${PREFIX}routine history [id]\`\` — recent runs and errors\n\`\`${PREFIX}routine remove <id>\`\` — delete a routine\n\`\`${PREFIX}routine pause/resume <id>\`\` — toggle a routine\n\`\`${PREFIX}routine daily <time> <text>\`\` — daily reminder\n\`\`${PREFIX}routine auto <when> <prompt>\`\` — LLM automation`, inline: true },
          { name: "Slash Commands", value: "`/settings` — configure Punch\n`/reset` — start a fresh Pi session\n`/logs` — sandbox + Pi gateway logs\n`/routine add` — schedule a routine\n`/remind` — quick one-shot reminder\nReact with the summon emoji on a message to invoke Punch on it\n**Voice memos:** DM me, or reply to me in a server (free: `GROQ_API_KEY` / `/apikey set groq`)\n**Pigeons:** permission DM, rate limits, optional buffer (`/settings pigeon`)", inline: true }
        )
        .setColor(0x0099ff)
        .setFooter({ text: "poolside/poolside/laguna-m.1" });
      await message.reply({ embeds: [embed] });
      return true;
    }

    case "invite": {
      const cid = registry.client.user.id;
      const url = `https://discord.com/api/oauth2/authorize?client_id=${cid}&permissions=0&scope=bot%20applications.commands`;
      await message.reply(`Re-invite the bot with this link to enable slash commands:\n${url}`);
      return true;
    }

    case "remember": {
      if (!rest) return void (await reply(message, "Usage: \`remember <text>\`")), true;
      const { ok, value: e } = await withMemoryStore(message, () => store.remember("user", uid, rest));
      if (!ok) return true;
      await reply(message, `Got it. Remembered (id \`${e.id}\`).`);
      return true;
    }

    case "remember-channel": {
      if (!rest) return void (await reply(message, "Usage: \`remember-channel <text>\`")), true;
      const { ok, value: e } = await withMemoryStore(message, () => store.remember("channel", cid, rest));
      if (!ok) return true;
      await reply(message, `Noted for this channel (id \`${e.id}\`).`);
      return true;
    }

    case "forget": {
      const id = rest.trim();
      if (!id) return void (await reply(message, "Usage: \`forget <id>\`")), true;
      const { ok, value: removed } = await withMemoryStore(
        message,
        () => store.forget("user", uid, id) || store.forget("channel", cid, id),
      );
      if (!ok) return true;
      await reply(message, removed ? `Forgot \`${id}\`.` : `No memory \`${id}\``);
      return true;
    }

    case "memories": {
      const { ok, value } = await withMemoryStore(message, () => ({
        u: store.list("user", uid),
        c: store.list("channel", cid),
      }));
      if (!ok) return true;
      const { u, c } = value;
      const lines = [];
      lines.push(`**Your memories (${u.length}):**`);
      for (const e of u) lines.push(`\`${e.id}\` ${e.text}`);
      lines.push(`\n**Channel memories (${c.length}):**`);
      for (const e of c) lines.push(`\`${e.id}\` ${e.text}`);
      await reply(message, lines.join("\n") || "Nothing yet.");
      return true;
    }

    case "reset": {
      await withUserRunLock(uid, () => store.clearSession(cid));
      await reply(message, "Fresh session. Prior context dropped.");
      return true;
    }

    case "stop": {
      // Cancel in-flight turn and clear the pending FIFO queue (do not drain).
      const queue = registry.userQueues.get(uid);
      if (!queue || queue.length === 0) {
        await reply(message, "No active or queued tasks.");
        return true;
      }

      const count = queue.length;
      const activeTask = queue[0];
      if (activeTask.abortController) {
         activeTask.abortController.abort();
      }
      const sessionId = store.getSession(activeTask.message.channelId);
      void abortSession(sessionId, uid);

      for (let i = 1; i < queue.length; i++) {
        const task = queue[i];
        if (task.thinking) {
          await task.thinking.edit({
            content: "❌ Request cancelled.",
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
        task.resolve();
      }

      queue.splice(1); // leave only in-flight; pending cleared (do not drain)
      console.log(`[queue] uid=${uid} stop cleared pending; aborting in-flight (was ${count})`);
      await reply(message, `🛑 Stopped all tasks (${count} request${count > 1 ? "s" : ""} cancelled).`);
      return true;
    }

    case "bg": {
      if (!rest) return void (await reply(message, "Usage: \`bg <command>\`")), true;
      try {
        const res = await runBackgroundTask(rest, uid);
        await reply(message, `🚀 Started background task:\n• **PID:** \`${res.pid}\`\n• **Log:** \`${res.logFile}\` (use \`!task-log ${res.logFile}\` to view logs)`);
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "exec":
    case "sh": {
      if (!rest) return void (await reply(message, "Usage: \`exec <command>\`")), true;
      try {
        await message.channel.sendTyping().catch(() => {});
        const res = await execCommand(rest, 30000, uid);
        const parts = [];
        if (res.stdout) parts.push(res.stdout.trim());
        if (res.stderr) parts.push(`stderr:\n${res.stderr.trim()}`);
        if (res.killed) parts.push(`(timed out)`);
        const text = parts.join("\n") || `(exit code ${res.exitCode}, no output)`;
        const icon = res.exitCode === 0 ? "✅" : "⚠️";
        const output = `${icon} Exit \`${res.exitCode}\`\`\`\n${text.slice(0, 1900)}\n\`\`\``;
        await reply(message, output);
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "tasks": {
      try {
        const res = await listBackgroundTasks(uid);
        const tasks = res.tasks || [];
        if (tasks.length === 0) {
          await reply(message, "No active background tasks running in the sandbox.");
          return true;
        }

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

        await message.reply({ embeds: [embed], components: [row] });
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "kill": {
      const pidStr = rest.trim();
      if (!pidStr) return void (await reply(message, "Usage: \`kill <pid>\`")), true;
      const pid = parseInt(pidStr);
      if (isNaN(pid)) return void (await reply(message, `Invalid PID: \`${pidStr}\``)), true;
      try {
        await killBackgroundTask(pid, uid);
        await reply(message, `🛑 Successfully killed process \`${pid}\`.`);
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "task-log": {
      const filename = rest.trim();
      if (!filename) return void (await reply(message, "Usage: \`task-log <filename>\`")), true;

      if (filename.includes("/") || filename.includes("..")) {
        return void (await reply(message, "Invalid filename. Logs must be located directly in the workspace.")), true;
      }

      try {
        const file = await getFile(filename, uid);
        const logContent = file.buffer.toString("utf8");
        const lines = logContent.trim().split("\n");
        const tail = lines.slice(-20).join("\n");

        await reply(message, `📄 **Log Tail for \`${filename}\` (last 20 lines):**\n\`\`\`\n${tail || "(empty)"}\n\`\`\``);
      } catch (err) {
        await reply(message, `⚠️ Error fetching log: ${err.message}`);
      }
      return true;
    }

    case "logs": {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "status") {
        try {
          await reply(message, logs.fetchLogStatus(uid));
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }
      let source = "all";
      let lineCount = 30;
      for (const p of parts) {
        if (["all", "supervisor", "serve", "activity"].includes(p)) source = p;
        else if (/^\d+$/.test(p)) lineCount = Math.min(100, parseInt(p, 10));
      }
      try {
        const result = await logs.fetchLogs(uid, { source, lines: lineCount });
        const formatted = logs.formatLogReply(result.lines, result.title);
        const running = result.running ? "✅" : "❌";
        await message.reply({
          content: `**${result.sandbox}** ${running}\n${formatted.content}`,
          files: formatted.truncated
            ? [{ attachment: Buffer.from(formatted.fullText, "utf8"), name: "logs.txt" }]
            : undefined,
        });
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "setup": {
      if (!message.guild) {
        return void (await reply(message, "Setup can only be used in a server.")), true;
      }
      try {
        const text = settings.lockChannel(
          message.guild.id,
          message.channelId,
          PREFIX,
          registry.client.user.username,
        );
        await reply(message, `✅ ${text}`);
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "forget-channel": {
      if (!message.guild) {
        return void (await reply(message, "This command only works in a server.")), true;
      }
      await reply(message, `✅ ${settings.unlockChannel(message.guild.id)}`);
      return true;
    }

    case "settings": {
      try {
        const text = await settings.handleSettingsPrefix(message, rest, settingsDeps());
        await reply(message, text);
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "remind": {
      if (!rest) return void (await reply(message, `Usage: \`${PREFIX}remind <when> <text>\` — e.g. \`${PREFIX}remind 30m take meds\``)), true;
      try {
        const zone = userTimeZone(uid);
        const { when, text } = splitWhenAndText(rest, zone);
        await createRoutineReply(message, {
          ...routineContextFromMessage(message),
          type: "message",
          payload: text,
          timezone: zone,
          schedule: { kind: "once", at: routines.parseTime(when, new Date(), zone) },
        });
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "routine": {
      const [sub, ...tail] = rest.split(/\s+/);
      const tailRest = tail.join(" ").trim();

      if (sub === "history") {
        const entries = routines.listHistory(uid, tailRest || null, 15);
        if (entries.length === 0) {
          await reply(message, "No routine history.");
        } else {
          const lines = entries.map((entry) => {
            const icon = entry.status === "succeeded" ? "✅" : entry.status === "failed" ? "❌" : "⏳";
            const error = entry.error ? ` — ${entry.error.slice(0, 180)}` : "";
            return `${icon} \`${entry.routineId}\` attempt ${entry.attempt} ${new Date(entry.startedAt).toLocaleString()}${error}`;
          });
          await reply(message, `**Routine history:**\n${lines.join("\n")}`);
        }
        return true;
      }

      if (sub === "remove") {
        const id = tailRest.trim();
        if (!id) return void (await reply(message, `Usage: \`${PREFIX}routine remove <id>\``)), true;
        const ok = routines.removeRoutine(id, uid);
        await reply(message, ok ? `Removed routine \`${id}\`.` : `No routine \`${id}\` found.`);
        return true;
      }

      if (sub === "pause" || sub === "resume") {
        const id = tailRest.trim();
        if (!id) return void (await reply(message, `Usage: \`${PREFIX}routine ${sub} <id>\``)), true;
        const r = routines.setRoutineEnabled(id, uid, sub === "resume");
        await reply(message, r ? `${sub === "pause" ? "Paused" : "Resumed"} routine \`${id}\`.` : `No routine \`${id}\` found.`);
        return true;
      }

      if (sub === "daily") {
        if (!tailRest) return void (await reply(message, `Usage: \`${PREFIX}routine daily <time> <text>\` — e.g. \`${PREFIX}routine daily 9am standup\``)), true;
        try {
          const zone = userTimeZone(uid);
          const { when, text } = splitWhenAndText(tailRest, zone);
          await createRoutineReply(message, {
            ...routineContextFromMessage(message),
            type: "message",
            payload: text,
            timezone: zone,
            schedule: routines.parseDailyTime(when, zone),
          });
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }

      if (sub === "every") {
        const intervalMatch = tailRest.match(/^(\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours))\s+(.+)$/i);
        if (!intervalMatch) {
          return void (await reply(message, `Usage: \`${PREFIX}routine every <interval> <text>\` — e.g. \`${PREFIX}routine every 6h check disk\``)), true;
        }
        try {
          await createRoutineReply(message, {
            ...routineContextFromMessage(message),
            type: "message",
            payload: intervalMatch[2].trim(),
            timezone: userTimeZone(uid),
            schedule: routines.parseEveryInterval(intervalMatch[1]),
          });
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }

      if (sub === "auto") {
        if (!tailRest) return void (await reply(message, `Usage: \`${PREFIX}routine auto <when> <prompt>\` — e.g. \`${PREFIX}routine auto 2m summarize /work\``)), true;
        try {
          const zone = userTimeZone(uid);
          const { when, text } = splitWhenAndText(tailRest, zone);
          await createRoutineReply(message, {
            ...routineContextFromMessage(message),
            type: "llm",
            payload: text,
            timezone: zone,
            schedule: { kind: "once", at: routines.parseTime(when, new Date(), zone) },
          });
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }

      if (sub === "list") {
        const list = routines.listRoutines(uid);
        await reply(message, list.length === 0
          ? "No routines yet."
          : `**Your routines:**\n${list.map(routines.formatRoutine).join("\n")}`);
        return true;
      }

      await reply(message, `Usage:\n\`${PREFIX}routine list\` — list routines\n\`${PREFIX}routine history [id]\` — recent runs/errors\n\`${PREFIX}routine remove <id>\`\n\`${PREFIX}routine pause/resume <id>\`\n\`${PREFIX}routine daily <time> <text>\`\n\`${PREFIX}routine every <interval> <text>\`\n\`${PREFIX}routine auto <when> <prompt>\``);
      return true;
    }

    default:
      return false;
  }
}

export {
  splitWhenAndText,
  routineContextFromMessage,
  routineContextFromInteraction,
  userTimeZone,
  statisticsExtrasForUser,
  createRoutineReply,
  sendLogReply,
  handleCommand,
};
