import * as store from "./memory.js";
import { normalizeTimeZone } from "./timezone.js";

export function reactionMatches(reaction, configured) {
  if (!configured) return false;
  const e = reaction.emoji;
  if (e.id) {
    return configured === e.name || configured === `<:${e.name}:${e.id}>`;
  }
  return e.name === configured;
}

function formatSettingsView(guildId, userId, prefix, botUsername) {
  const lines = ["**Settings**"];
  if (guildId) {
    const lock = store.getAllowedChannel(guildId);
    const summon = store.getSummonWord(guildId);
    const gs = store.getGuildSettings(guildId);
    lines.push("**Server:**");
    lines.push(lock ? `- Channel lock: <#${lock}>` : "- Channel lock: none (any channel)");
    lines.push(summon ? `- Summon word: \`${prefix}${summon}\`` : `- Summon word: none (use @${botUsername})`);
    lines.push(`- Reaction summon: ${gs.reactionSummonEnabled ? "on" : "off"} (emoji: ${gs.reactionSummonEmoji})`);
    lines.push(`- Progress: ${gs.reactionProgressEnabled ? "on" : "off"} (mode: ${gs.reactionProgressMode})`);
    lines.push(`- Context: ${gs.contextMode === "thread" ? "thread (reply-scoped)" : "channel (recent)"}`);
  }
  const trigger = store.getUserTrigger(userId);
  const us = store.getUserSettings(userId);
  lines.push("**Personal:**");
  lines.push(trigger ? `- Trigger word: \`${trigger}\`` : "- Trigger word: none");
  lines.push(`- Multitask: ${us.multitaskEnabled ? "on" : "off"}`);
  lines.push(`- Timezone: \`${us.timeZone}\``);
  lines.push(`- Working pigeons: ${us.workingPigeonsEnabled ? "on" : "off"}`);
  const doneParts = [];
  if (us.pigeonDonePigeon) doneParts.push("pigeon");
  if (us.pigeonDoneDm) doneParts.push("dm");
  if (us.pigeonDoneAgent) doneParts.push("agent");
  lines.push(
    doneParts.length
      ? `- Pigeon done notify: ${doneParts.join(", ")}`
      : "- Pigeon done notify: off",
  );
  lines.push(`- Pigeon ask unknown: ${us.pigeonAskUnknown ? "on" : "off"}`);
  lines.push(`- Pigeon buffer: ${us.pigeonBufferSeconds ? `${us.pigeonBufferSeconds}s` : "off"}`);
  lines.push(
    `- Pigeon rate limit: ${us.pigeonRateLimitCount} per ${Math.round((us.pigeonRateLimitWindowMs || 600_000) / 60_000)} min`,
  );
  const trusted = us.trustedPigeonSenders || [];
  lines.push(
    trusted.length
      ? `- Trusted pigeon senders: ${trusted.map((n) => `\`${n}\``).join(", ")}`
      : "- Trusted pigeon senders: none",
  );
  const denied = us.deniedPigeonSenders || [];
  lines.push(
    denied.length
      ? `- Denied pigeon senders: ${denied.map((n) => `\`${n}\``).join(", ")}`
      : "- Denied pigeon senders: none",
  );
  return lines.join("\n");
}

export function setSummonWord(guildId, word, prefix) {
  if (word) {
    store.setSummonWord(guildId, word);
    return `Summon word set to **${word}**. Say \`${prefix}${word}\` to invoke me.`;
  }
  store.clearSummonWord(guildId);
  return "Summon word cleared. Use @mention to invoke me.";
}

export function lockChannel(guildId, channelId, prefix, botUsername) {
  store.setAllowedChannel(guildId, channelId);
  const word = store.getSummonWord(guildId);
  const summonText = word ? ` (summon: \`${prefix}${word}\`)` : ` (summon: @${botUsername})`;
  return `Channel locked to <#${channelId}>${summonText}.`;
}

export function unlockChannel(guildId) {
  const had = store.getAllowedChannel(guildId);
  if (!had) return "No channel lock was set.";
  store.clearAllowedChannel(guildId);
  return "Channel lock removed. I can respond in any channel again.";
}

export function setUserTriggerWord(userId, word) {
  if (word) {
    if (!/^[a-z0-9_-]+$/.test(word)) {
      throw new Error("Trigger word must be letters, numbers, hyphens, or underscores only.");
    }
    store.setUserTrigger(userId, word);
    return `Personal trigger set to **${word}**.`;
  }
  store.setUserTrigger(userId, null);
  return "Personal trigger cleared.";
}

export function setReactionEmoji(guildId, emoji) {
  if (emoji) {
    store.patchGuildSettings(guildId, { reactionSummonEmoji: emoji });
    return `Reaction summon emoji set to ${emoji}.`;
  }
  store.patchGuildSettings(guildId, { reactionSummonEmoji: store.GUILD_SETTINGS_DEFAULTS.reactionSummonEmoji });
  return `Reaction summon emoji reset to ${store.GUILD_SETTINGS_DEFAULTS.reactionSummonEmoji}.`;
}

export function setReactionSummonEnabled(guildId, enabled) {
  store.patchGuildSettings(guildId, { reactionSummonEnabled: enabled });
  return `Reaction summon ${enabled ? "enabled" : "disabled"}.`;
}

export function setProgressEnabled(guildId, enabled) {
  store.patchGuildSettings(guildId, { reactionProgressEnabled: enabled });
  return `Progress reactions ${enabled ? "enabled" : "disabled"}.`;
}

export function setProgressMode(guildId, mode) {
  if (!["both", "text", "reactions"].includes(mode)) {
    throw new Error("Mode must be `both`, `text`, or `reactions`.");
  }
  store.patchGuildSettings(guildId, { reactionProgressMode: mode });
  return `Progress mode set to **${mode}**.`;
}

export function setMultitaskEnabled(userId, enabled) {
  store.patchUserSettings(userId, { multitaskEnabled: enabled });
  return enabled
    ? "Multitask **enabled** — new messages while I'm busy spawn parallel subtasks instead of queuing."
    : "Multitask **disabled** — messages queue until the current turn finishes.";
}

export function setWorkingPigeonsEnabled(userId, enabled) {
  store.patchUserSettings(userId, { workingPigeonsEnabled: enabled });
  return enabled
    ? "Working pigeons **enabled** — agent pigeons will wake your Punch automatically."
    : "Working pigeons **disabled** — agent pigeons will DM you only (no auto-turn).";
}

export function setUserTimeZone(userId, timeZone) {
  const normalized = normalizeTimeZone(timeZone);
  store.patchUserSettings(userId, { timeZone: normalized });
  return `Timezone set to **${normalized}**.`;
}

export function clearUserTimeZone(userId) {
  store.patchUserSettings(userId, { timeZone: "UTC" });
  return "Timezone reset to **UTC**.";
}

const PIGEON_DONE_KEYS = {
  pigeon: "pigeonDonePigeon",
  dm: "pigeonDoneDm",
  agent: "pigeonDoneAgent",
};

export function setPigeonDoneNotify(userId, which, enabled) {
  const key = PIGEON_DONE_KEYS[which];
  if (!key) {
    throw new Error("Notify target must be `pigeon`, `dm`, `agent`, or `all`.");
  }
  if (which === "all") {
    store.patchUserSettings(userId, {
      pigeonDonePigeon: enabled,
      pigeonDoneDm: enabled,
      pigeonDoneAgent: enabled,
    });
    return enabled
      ? "Pigeon done notifications **enabled** for pigeon, DM, and agent."
      : "Pigeon done notifications **disabled**.";
  }
  store.patchUserSettings(userId, { [key]: enabled });
  return `Pigeon done **${which}** notify ${enabled ? "enabled" : "disabled"}.`;
}

export function setPigeonAskUnknown(userId, enabled) {
  store.patchUserSettings(userId, { pigeonAskUnknown: enabled });
  return enabled
    ? "Unknown agent pigeons will **ask permission** before running."
    : "Unknown agent pigeons will **run without asking** (trusted list still applies for explicit trust).";
}

export function setPigeonBufferSeconds(userId, seconds) {
  const sec = Math.max(0, Math.min(30, Math.floor(Number(seconds) || 0)));
  store.patchUserSettings(userId, { pigeonBufferSeconds: sec });
  return sec
    ? `Pigeon buffer set to **${sec}s** (react 🛑 on the DM to cancel).`
    : "Pigeon buffer **disabled** — approved pigeons run immediately.";
}

export function setPigeonTrust(userId, action, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n || !/^[a-z0-9_-]+$/.test(n)) {
    throw new Error("Sandbox name must be letters, numbers, hyphens, or underscores.");
  }
  const us = store.getUserSettings(userId);
  const list = [...(us.trustedPigeonSenders || [])];
  if (action === "add") {
    if (!list.includes(n)) list.push(n);
    store.patchUserSettings(userId, { trustedPigeonSenders: list });
    return `**${n}** added to trusted pigeon senders.`;
  }
  if (action === "remove") {
    store.patchUserSettings(userId, { trustedPigeonSenders: list.filter((x) => x !== n) });
    return `**${n}** removed from trusted pigeon senders.`;
  }
  throw new Error("Action must be `add` or `remove`.");
}

export function setPigeonDeny(userId, action, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n || !/^[a-z0-9_-]+$/.test(n)) {
    throw new Error("Sandbox name must be letters, numbers, hyphens, or underscores.");
  }
  const us = store.getUserSettings(userId);
  const list = [...(us.deniedPigeonSenders || [])];
  if (action === "add") {
    if (!list.includes(n)) list.push(n);
    store.patchUserSettings(userId, { deniedPigeonSenders: list });
    return `**${n}** added to denied pigeon senders.`;
  }
  if (action === "remove") {
    store.patchUserSettings(userId, { deniedPigeonSenders: list.filter((x) => x !== n) });
    return `**${n}** removed from denied pigeon senders.`;
  }
  throw new Error("Action must be `add` or `remove`.");
}

export function setPigeonRateLimit(userId, count, minutes) {
  const c = Math.max(1, Math.min(30, Math.floor(Number(count) || 5)));
  const m = Math.max(1, Math.min(60, Math.floor(Number(minutes) || 10)));
  store.patchUserSettings(userId, {
    pigeonRateLimitCount: c,
    pigeonRateLimitWindowMs: m * 60_000,
  });
  return `Pigeon rate limit: **${c}** per **${m}** min.`;
}

export async function handleSettingsPrefix(message, rest, { prefix, botUsername, setSecret, getSecrets }) {
  const uid = message.author.id;
  const guildId = message.guild?.id;
  const isDM = !guildId;
  const tokens = rest.trim().split(/\s+/);
  const sub = tokens[0]?.toLowerCase();
  const sub2 = tokens[1]?.toLowerCase();
  const sub3 = tokens[2];

  if (!sub || sub === "list" || sub === "view") {
    return formatSettingsView(guildId, uid, prefix, botUsername);
  }

  if (sub === "summon") {
    if (!guildId) throw new Error("Summon word is a server setting — use this in a server.");
    const word = tokens.slice(1).join(" ").trim();
    return setSummonWord(guildId, word || null, prefix);
  }

  if (sub === "channel") {
    if (!guildId) throw new Error("Channel lock is a server setting — use this in a server.");
    if (sub2 === "lock") {
      return lockChannel(guildId, message.channelId, prefix, botUsername);
    }
    if (sub2 === "unlock") {
      return unlockChannel(guildId);
    }
    throw new Error(`Usage: \`${prefix}settings channel lock\` or \`${prefix}settings channel unlock\``);
  }

  if (sub === "trigger") {
    const word = tokens.slice(1).join(" ").trim();
    return setUserTriggerWord(uid, word || null);
  }

  if (sub === "reaction") {
    if (!guildId) throw new Error("Reaction settings are server-only.");
    if (sub2 === "emoji") {
      const emoji = tokens.slice(2).join(" ").trim();
      return setReactionEmoji(guildId, emoji || null);
    }
    if (sub2 === "summon") {
      if (sub3 === "enable") return setReactionSummonEnabled(guildId, true);
      if (sub3 === "disable") return setReactionSummonEnabled(guildId, false);
      throw new Error(`Usage: \`${prefix}settings reaction summon enable|disable\``);
    }
    throw new Error(`Usage: \`${prefix}settings reaction emoji <emoji>\` or summon enable|disable`);
  }

  if (sub === "progress") {
    if (!guildId) throw new Error("Progress settings are server-only.");
    if (sub2 === "enable") return setProgressEnabled(guildId, true);
    if (sub2 === "disable") return setProgressEnabled(guildId, false);
    if (sub2 === "mode" && sub3) return setProgressMode(guildId, sub3);
    throw new Error(`Usage: \`${prefix}settings progress enable|disable|mode <both|text|reactions>\``);
  }

  if (sub === "context") {
    if (!guildId) throw new Error("Context mode is a server setting — use this in a server.");
    if (sub2 === "thread") {
      store.patchGuildSettings(guildId, { contextMode: "thread" });
      return "Context mode set to **thread** — each summon only sees its own reply thread (plus a small residue for top-level pings).";
    }
    if (sub2 === "channel") {
      store.patchGuildSettings(guildId, { contextMode: "channel" });
      return "Context mode set to **channel** — summons see the recent channel history (legacy behavior).";
    }
    throw new Error(`Usage: \`${prefix}settings context thread|channel\``);
  }

  if (sub === "pigeon") {
    if (sub2 === "working") {
      if (sub3 === "on" || sub3 === "enable") return setWorkingPigeonsEnabled(uid, true);
      if (sub3 === "off" || sub3 === "disable") return setWorkingPigeonsEnabled(uid, false);
      throw new Error(`Usage: \`${prefix}settings pigeon working on|off\``);
    }
    if (sub2 === "done") {
      const target = tokens[2]?.toLowerCase();
      const state = tokens[3]?.toLowerCase();
      if (!target || !state) {
        throw new Error(
          `Usage: \`${prefix}settings pigeon done <pigeon|dm|agent|all> <on|off>\``,
        );
      }
      const enabled = state === "on" || state === "enable";
      if (state !== "on" && state !== "off" && state !== "enable" && state !== "disable") {
        throw new Error("State must be `on` or `off`.");
      }
      return setPigeonDoneNotify(uid, target, enabled);
    }
    if (sub2 === "ask") {
      if (sub3 === "on" || sub3 === "enable") return setPigeonAskUnknown(uid, true);
      if (sub3 === "off" || sub3 === "disable") return setPigeonAskUnknown(uid, false);
      throw new Error(`Usage: \`${prefix}settings pigeon ask on|off\``);
    }
    if (sub2 === "buffer" || sub2 === "buffer-set") {
      const sec = tokens[2];
      if (sec === undefined || sec === "") {
        throw new Error(`Usage: \`${prefix}settings pigeon buffer <0-30>\` (0 = off)`);
      }
      return setPigeonBufferSeconds(uid, sec);
    }
    if (sub2 === "trust") {
      const action = sub3;
      const name = tokens[3];
      if (!action || !name) {
        throw new Error(`Usage: \`${prefix}settings pigeon trust add|remove <sandbox-name>\``);
      }
      return setPigeonTrust(uid, action, name);
    }
    if (sub2 === "deny") {
      const action = sub3;
      const name = tokens[3];
      if (!action || !name) {
        throw new Error(`Usage: \`${prefix}settings pigeon deny add|remove <sandbox-name>\``);
      }
      return setPigeonDeny(uid, action, name);
    }
    if (sub2 === "rate") {
      const count = tokens[2];
      const minutes = tokens[3];
      if (!count) {
        throw new Error(`Usage: \`${prefix}settings pigeon rate <count> <minutes>\``);
      }
      return setPigeonRateLimit(uid, count, minutes || 10);
    }
    throw new Error(
      `Usage: \`${prefix}settings pigeon working|ask|buffer|trust|deny|rate|done ...\``,
    );
  }

  if (sub === "multitask") {
    if (sub2 === "on" || sub2 === "enable") return setMultitaskEnabled(uid, true);
    if (sub2 === "off" || sub2 === "disable") return setMultitaskEnabled(uid, false);
    throw new Error(`Usage: \`${prefix}settings multitask on|off|enable|disable\``);
  }

  if (sub === "timezone") {
    if (sub2 === "set") {
      const timeZone = tokens.slice(2).join(" ").trim();
      if (!timeZone) throw new Error(`Usage: \`${prefix}settings timezone set <IANA timezone>\``);
      return setUserTimeZone(uid, timeZone);
    }
    if (sub2 === "clear" || sub2 === "reset") return clearUserTimeZone(uid);
    throw new Error(`Usage: \`${prefix}settings timezone set <IANA timezone>\` or clear`);
  }

  if (sub === "secret" || sub === "secrets") {
    if (!isDM) throw new Error("DM me to manage secrets — use `/settings secret` in DMs.");
    if (sub === "secrets" || tokens.length === 1) {
      const { secrets } = await getSecrets(uid);
      const keys = Object.keys(secrets || {});
      return keys.length ? `**Stored secrets:** ${keys.map((k) => `\`${k}\``).join(", ")}` : "No secrets stored.";
    }
    const secretPart = rest.replace(/^secret\s+/i, "").trim();
    const eq = secretPart.indexOf("=");
    if (eq < 0) throw new Error(`Usage: \`${prefix}settings secret <key>=<value>\``);
    const key = secretPart.slice(0, eq).trim();
    const value = secretPart.slice(eq + 1).trim();
    await setSecret(key, value, uid);
    return `Secret \`${key}\` stored.`;
  }

  throw new Error(`Unknown setting. Try \`${prefix}settings view\` or use \`/settings view\`.`);
}

function requireGuild(interaction) {
  if (!interaction.guild) {
    throw new Error("This setting only works in a server.");
  }
  return interaction.guild.id;
}

export async function handleSettingsSlash(interaction, { prefix, botUsername, setSecret, getSecrets }) {
  const sub = interaction.options.getSubcommandGroup(false);
  const cmd = interaction.options.getSubcommand();
  const uid = interaction.user.id;
  const guildId = interaction.guild?.id;

  if (cmd === "view") {
    const text = formatSettingsView(guildId, uid, prefix, botUsername);
    await interaction.reply({ content: text });
    return;
  }

  if (sub === "summon") {
    const gid = requireGuild(interaction);
    if (cmd === "set") {
      const word = interaction.options.getString("word", true);
      await interaction.reply({ content: setSummonWord(gid, word, prefix) });
    } else {
      await interaction.reply({ content: setSummonWord(gid, null, prefix) });
    }
    return;
  }

  if (sub === "channel") {
    const gid = requireGuild(interaction);
    if (cmd === "lock") {
      await interaction.reply({
        content: lockChannel(gid, interaction.channelId, prefix, botUsername),
      });
    } else {
      await interaction.reply({ content: unlockChannel(gid) });
    }
    return;
  }

  if (sub === "trigger") {
    if (cmd === "set") {
      const word = interaction.options.getString("word", true).toLowerCase();
      await interaction.reply({ content: setUserTriggerWord(uid, word) });
    } else {
      await interaction.reply({ content: setUserTriggerWord(uid, null) });
    }
    return;
  }

  if (sub === "reaction") {
    const gid = requireGuild(interaction);
    if (cmd === "emoji-set") {
      const emoji = interaction.options.getString("emoji", true);
      await interaction.reply({ content: setReactionEmoji(gid, emoji) });
    } else if (cmd === "emoji-clear") {
      await interaction.reply({ content: setReactionEmoji(gid, null) });
    } else if (cmd === "summon-enable") {
      await interaction.reply({ content: setReactionSummonEnabled(gid, true) });
    } else if (cmd === "summon-disable") {
      await interaction.reply({ content: setReactionSummonEnabled(gid, false) });
    }
    return;
  }

  if (sub === "progress") {
    const gid = requireGuild(interaction);
    if (cmd === "enable") {
      await interaction.reply({ content: setProgressEnabled(gid, true) });
    } else if (cmd === "disable") {
      await interaction.reply({ content: setProgressEnabled(gid, false) });
    } else if (cmd === "mode") {
      const mode = interaction.options.getString("mode", true);
      await interaction.reply({ content: setProgressMode(gid, mode) });
    }
    return;
  }

  if (sub === "context") {
    const gid = requireGuild(interaction);
    if (cmd === "thread") {
      store.patchGuildSettings(gid, { contextMode: "thread" });
      await interaction.reply({ content: "Context mode set to **thread** — each summon only sees its own reply thread (plus a small residue for top-level pings)." });
    } else if (cmd === "channel") {
      store.patchGuildSettings(gid, { contextMode: "channel" });
      await interaction.reply({ content: "Context mode set to **channel** — summons see the recent channel history (legacy behavior)." });
    } else {
      await interaction.reply({ content: "Unknown context mode." });
    }
    return;
  }

  if (sub === "pigeon") {
    if (cmd === "working-enable") {
      await interaction.reply({ content: setWorkingPigeonsEnabled(uid, true) });
    } else if (cmd === "working-disable") {
      await interaction.reply({ content: setWorkingPigeonsEnabled(uid, false) });
    } else if (cmd === "done-set") {
      const which = interaction.options.getString("which", true);
      const state = interaction.options.getString("state", true);
      const enabled = state === "on";
      await interaction.reply({ content: setPigeonDoneNotify(uid, which, enabled) });
    } else if (cmd === "ask-enable") {
      await interaction.reply({ content: setPigeonAskUnknown(uid, true) });
    } else if (cmd === "ask-disable") {
      await interaction.reply({ content: setPigeonAskUnknown(uid, false) });
    } else if (cmd === "buffer-set") {
      const sec = interaction.options.getInteger("seconds", true);
      await interaction.reply({ content: setPigeonBufferSeconds(uid, sec) });
    } else if (cmd === "trust-add") {
      const name = interaction.options.getString("name", true);
      await interaction.reply({ content: setPigeonTrust(uid, "add", name) });
    } else if (cmd === "trust-remove") {
      const name = interaction.options.getString("name", true);
      await interaction.reply({ content: setPigeonTrust(uid, "remove", name) });
    } else if (cmd === "deny-add") {
      const name = interaction.options.getString("name", true);
      await interaction.reply({ content: setPigeonDeny(uid, "add", name) });
    } else if (cmd === "deny-remove") {
      const name = interaction.options.getString("name", true);
      await interaction.reply({ content: setPigeonDeny(uid, "remove", name) });
    } else if (cmd === "rate-set") {
      const count = interaction.options.getInteger("count", true);
      const minutes = interaction.options.getInteger("minutes") ?? 10;
      await interaction.reply({ content: setPigeonRateLimit(uid, count, minutes) });
    }
    return;
  }

  if (sub === "multitask") {
    if (cmd === "enable") {
      await interaction.reply({ content: setMultitaskEnabled(uid, true) });
    } else if (cmd === "disable") {
      await interaction.reply({ content: setMultitaskEnabled(uid, false) });
    }
    return;
  }

  if (sub === "timezone") {
    if (cmd === "set") {
      const timeZone = interaction.options.getString("timezone", true);
      await interaction.reply({ content: setUserTimeZone(uid, timeZone) });
    } else {
      await interaction.reply({ content: clearUserTimeZone(uid) });
    }
    return;
  }

  if (sub === "secret") {
    if (guildId) {
      await interaction.reply({ content: "DM me to manage secrets." });
      return;
    }
    if (cmd === "set") {
      const key = interaction.options.getString("key", true);
      const value = interaction.options.getString("value", true);
      await setSecret(key, value, uid);
      await interaction.reply({ content: `Secret \`${key}\` stored.` });
    } else {
      const { secrets } = await getSecrets(uid);
      const keys = Object.keys(secrets || {});
      const text = keys.length
        ? `**Stored secrets:** ${keys.map((k) => `\`${k}\``).join(", ")}`
        : "No secrets stored.";
      await interaction.reply({ content: text });
    }
    return;
  }

  await interaction.reply({ content: "Unknown settings command." });
}

export function getSlashCommandDefinition() {
  return {
    name: "settings",
    description: "Configure Punch for this server or your account",
    options: [
      { type: 1, name: "view", description: "Show current settings" },
      {
        type: 2,
        name: "summon",
        description: "Guild summon word",
        options: [
          {
            type: 1,
            name: "set",
            description: "Set summon word",
            options: [{ type: 3, name: "word", description: "Word that invokes Punch", required: true }],
          },
          { type: 1, name: "clear", description: "Clear summon word" },
        ],
      },
      {
        type: 2,
        name: "channel",
        description: "Restrict Punch to one channel",
        options: [
          { type: 1, name: "lock", description: "Lock to this channel" },
          { type: 1, name: "unlock", description: "Remove channel lock" },
        ],
      },
      {
        type: 2,
        name: "trigger",
        description: "Your personal trigger word",
        options: [
          {
            type: 1,
            name: "set",
            description: "Set personal trigger",
            options: [{ type: 3, name: "word", description: "Trigger word", required: true }],
          },
          { type: 1, name: "clear", description: "Clear personal trigger" },
        ],
      },
      {
        type: 2,
        name: "reaction",
        description: "Reaction summon settings",
        options: [
          {
            type: 1,
            name: "emoji-set",
            description: "Set reaction summon emoji",
            options: [{ type: 3, name: "emoji", description: "Emoji (unicode or custom name)", required: true }],
          },
          { type: 1, name: "emoji-clear", description: "Reset summon emoji to robot" },
          { type: 1, name: "summon-enable", description: "Enable reaction summoning" },
          { type: 1, name: "summon-disable", description: "Disable reaction summoning" },
        ],
      },
      {
        type: 2,
        name: "progress",
        description: "Progress indicator style",
        options: [
          { type: 1, name: "enable", description: "Enable progress indicators" },
          { type: 1, name: "disable", description: "Disable progress indicators" },
          {
            type: 1,
            name: "mode",
            description: "How to show progress in guild channels",
            options: [{
              type: 3,
              name: "mode",
              description: "both = text + reactions, text = thinking reply only, reactions = emoji only",
              required: true,
              choices: [
                { name: "both", value: "both" },
                { name: "text", value: "text" },
                { name: "reactions", value: "reactions" },
              ],
            }],
          },
        ],
      },
      {
        type: 2,
        name: "context",
        description: "Context isolation mode for summons",
        options: [
          { type: 1, name: "thread", description: "Reply-thread scoped context (default isolation)" },
          { type: 1, name: "channel", description: "Legacy recent-channel-history context" },
        ],
      },
      {
        type: 2,
        name: "pigeon",
        description: "Agent pigeon settings (personal)",
        options: [
          { type: 1, name: "working-enable", description: "Allow agent pigeons to wake your Punch" },
          { type: 1, name: "working-disable", description: "Agent pigeons notify only, no auto-turn" },
          {
            type: 1,
            name: "done-set",
            description: "When you finish an agent pigeon task, notify the sender",
            options: [
              {
                type: 3,
                name: "which",
                description: "pigeon = inbox, dm = Discord DM, agent = wake their Punch, all = every channel",
                required: true,
                choices: [
                  { name: "pigeon", value: "pigeon" },
                  { name: "dm", value: "dm" },
                  { name: "agent", value: "agent" },
                  { name: "all", value: "all" },
                ],
              },
              {
                type: 3,
                name: "state",
                description: "on or off",
                required: true,
                choices: [
                  { name: "on", value: "on" },
                  { name: "off", value: "off" },
                ],
              },
            ],
          },
          { type: 1, name: "ask-enable", description: "Ask permission before running unknown agent pigeons" },
          { type: 1, name: "ask-disable", description: "Run unknown agent pigeons without asking" },
          {
            type: 1,
            name: "buffer-set",
            description: "Seconds to wait before running approved pigeons (0 = off)",
            options: [{ type: 4, name: "seconds", description: "0–30", required: true, min_value: 0, max_value: 30 }],
          },
          {
            type: 1,
            name: "trust-add",
            description: "Always allow agent pigeons from a sandbox",
            options: [{ type: 3, name: "name", description: "Sandbox name (e.g. ember)", required: true }],
          },
          {
            type: 1,
            name: "trust-remove",
            description: "Remove a sandbox from trusted pigeon senders",
            options: [{ type: 3, name: "name", description: "Sandbox name", required: true }],
          },
          {
            type: 1,
            name: "deny-add",
            description: "Always block agent pigeons from a sandbox",
            options: [{ type: 3, name: "name", description: "Sandbox name (e.g. ember)", required: true }],
          },
          {
            type: 1,
            name: "deny-remove",
            description: "Remove a sandbox from denied pigeon senders",
            options: [{ type: 3, name: "name", description: "Sandbox name", required: true }],
          },
          {
            type: 1,
            name: "rate-set",
            description: "Max agent pigeons per time window",
            options: [
              { type: 4, name: "count", description: "Max pigeons", required: true, min_value: 1, max_value: 30 },
              { type: 4, name: "minutes", description: "Window in minutes (default 10)", min_value: 1, max_value: 60 },
            ],
          },
        ],
      },
      {
        type: 2,
        name: "multitask",
        description: "Parallel subtasks while main chat is busy (personal)",
        options: [
          { type: 1, name: "enable", description: "Spawn workers instead of queuing when busy" },
          { type: 1, name: "disable", description: "Queue messages until the current turn finishes" },
        ],
      },
      {
        type: 2,
        name: "timezone",
        description: "Timezone used for message timestamps (personal)",
        options: [
          {
            type: 1,
            name: "set",
            description: "Set an IANA timezone",
            options: [{ type: 3, name: "timezone", description: "For example America/New_York", required: true }],
          },
          { type: 1, name: "clear", description: "Reset timezone to UTC" },
        ],
      },
      {
        type: 2,
        name: "secret",
        description: "Sandbox secrets (DM only)",
        options: [
          {
            type: 1,
            name: "set",
            description: "Store a secret",
            options: [
              { type: 3, name: "key", description: "Secret name", required: true },
              { type: 3, name: "value", description: "Secret value", required: true },
            ],
          },
          { type: 1, name: "list", description: "List secret keys" },
        ],
      },
    ],
  };
}
