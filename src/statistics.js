import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import * as state from "./state.js";

export const STATISTICS_PERIODS = ["day", "week", "month", "year"];

const PERIOD_LABELS = {
  day: "24 hours",
  week: "7 days",
  month: "30 days",
  year: "365 days",
};

export function tokenFieldsFromAgent(res) {
  const t = res?.tokenUsage;
  if (!t && !res?.cost) return {};
  const input = Number(t?.input) || 0;
  const output = Number(t?.output) || 0;
  const reasoning = Number(t?.reasoning) || 0;
  const cacheRead = Number(t?.cache?.read) || 0;
  const cacheWrite = Number(t?.cache?.write) || 0;
  const total = input + output + reasoning + cacheRead + cacheWrite;
  if (!total && !res?.cost) return { cost: Number(res?.cost) || 0 };
  return {
    cost: Number(res?.cost) || 0,
    tokens: { input, output, reasoning, cacheRead, cacheWrite, total },
  };
}

export function formatTokenCount(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatDuration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value}ms`;
  const secs = value / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatRelative(ts) {
  if (!ts) return "never";
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function successRate(stats) {
  if (!stats.totalTurns) return "—";
  return `${Math.round((stats.successfulTurns / stats.totalTurns) * 100)}%`;
}

export function buildStatisticsEmbed(userId, period, extras = {}) {
  const stats = state.getUsageStatistics(userId, period);
  const periodLabel = PERIOD_LABELS[period] || period;
  const embed = new EmbedBuilder()
    .setTitle("Punch statistics")
    .setColor(0x5865f2)
    .setDescription(`Usage for the last **${periodLabel}**.`)
    .addFields(
      {
        name: "Your messages",
        value: String(stats.userMessages),
        inline: true,
      },
      {
        name: "Total tokens",
        value: formatTokenCount(stats.tokens.total),
        inline: true,
      },
      {
        name: "Agent turns",
        value: String(stats.totalTurns),
        inline: true,
      },
      {
        name: "Input tokens",
        value: formatTokenCount(stats.tokens.input),
        inline: true,
      },
      {
        name: "Output tokens",
        value: formatTokenCount(stats.tokens.output + stats.tokens.reasoning),
        inline: true,
      },
      {
        name: "Cache tokens",
        value: formatTokenCount(stats.tokens.cacheRead + stats.tokens.cacheWrite),
        inline: true,
      },
      {
        name: "Automations",
        value: String(stats.automations),
        inline: true,
      },
      {
        name: "Success rate",
        value: successRate(stats),
        inline: true,
      },
      {
        name: "Avg response",
        value: stats.avgDurationMs ? formatDuration(stats.avgDurationMs) : "—",
        inline: true,
      },
    )
    .setFooter({ text: `Last active ${formatRelative(stats.lastActivityTs)}` })
    .setTimestamp();

  if (stats.totalCost > 0) {
    embed.addFields({
      name: "Estimated cost",
      value: `$${stats.totalCost.toFixed(4)}`,
      inline: true,
    });
  }

  if (extras.sandboxName) {
    embed.addFields({
      name: "Sandbox",
      value: extras.sandboxName,
      inline: true,
    });
  }

  if (extras.activeRoutines != null) {
    embed.addFields({
      name: "Active routines",
      value: String(extras.activeRoutines),
      inline: true,
    });
  }

  if (extras.memoryRecords != null) {
    embed.addFields({
      name: "Stored memories",
      value: String(extras.memoryRecords),
      inline: true,
    });
  }

  return embed;
}

export function buildStatisticsComponents(userId, period) {
  const row = new ActionRowBuilder();
  for (const value of STATISTICS_PERIODS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`stats:${value}:${userId}`)
        .setLabel(value.charAt(0).toUpperCase() + value.slice(1))
        .setStyle(value === period ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  return [row];
}

export function statisticsButtonCustomId(period, userId) {
  return `stats:${period}:${userId}`;
}

export function parseStatisticsButtonCustomId(customId) {
  const [kind, period, userId] = String(customId || "").split(":");
  if (kind !== "stats" || !STATISTICS_PERIODS.includes(period) || !userId) return null;
  return { period, userId };
}

export async function handleStatisticsInteraction(interaction, extrasForUser) {
  const parsed = parseStatisticsButtonCustomId(interaction.customId);
  if (!parsed) return false;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      content: "These statistics belong to another user.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const extras = typeof extrasForUser === "function" ? await extrasForUser(parsed.userId) : (extrasForUser || {});
  const embed = buildStatisticsEmbed(parsed.userId, parsed.period, extras);
  const components = buildStatisticsComponents(parsed.userId, parsed.period);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components });
  } else {
    await interaction.update({ embeds: [embed], components });
  }
  return true;
}

export async function handleStatisticsCommand(interaction, extrasForUser) {
  const uid = interaction.user.id;
  const extras = typeof extrasForUser === "function" ? await extrasForUser(uid) : (extrasForUser || {});
  const embed = buildStatisticsEmbed(uid, "week", extras);
  const components = buildStatisticsComponents(uid, "week");
  await interaction.reply({
    embeds: [embed],
    components,
    flags: MessageFlags.Ephemeral,
  });
}
