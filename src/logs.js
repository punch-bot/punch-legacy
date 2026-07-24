import * as sandbox from "./sandbox-manager.js";
import { sandboxNameForUser, getActivityLogs } from "./agent.js";

const REDACT = [
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
  /(api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi,
  /OPENCODE_SERVER_PASSWORD=\S+/g,
];

export function redactLogText(text) {
  let out = text;
  for (const re of REDACT) out = out.replace(re, "[redacted]");
  return out;
}

export function filterDockerLines(lines, source) {
  if (source === "all") return lines;
  if (source === "supervisor") {
    return lines.filter((l) => l.includes("[supervisor]"));
  }
  if (source === "serve") {
    return lines.filter((l) => !l.includes("[supervisor]"));
  }
  return lines;
}

function tailLines(lines, n) {
  return lines.slice(-Math.max(1, Math.min(n, 200)));
}

export function formatLogReply(lines, title) {
  const body = redactLogText(lines.join("\n") || "(empty)");
  const header = `**${title}** (${lines.length} line${lines.length === 1 ? "" : "s"})\n\`\`\`\n`;
  const footer = "\n```";
  const maxBody = 1900 - header.length - footer.length;
  let shown = body;
  let truncated = false;
  if (shown.length > maxBody) {
    shown = "…(truncated)\n" + shown.slice(-(maxBody - 15));
    truncated = true;
  }
  return {
    content: header + shown + footer,
    fullText: body,
    truncated,
  };
}

export async function fetchLogs(userId, { lines = 30, source = "all" } = {}) {
  const name = sandboxNameForUser(userId);
  if (!name) throw new Error("No sandbox assigned.");

  if (source === "activity") {
    const activity = getActivityLogs(userId, lines);
    return {
      lines: activity,
      title: "Pi activity (recent turns)",
      running: sandbox.isContainerRunning(name),
      sandbox: name,
    };
  }

  const raw = sandbox.getContainerLogs(name, Math.min(lines * 3, 500));
  const allLines = raw.split("\n").filter((l) => l.length > 0);
  const filtered = filterDockerLines(allLines, source);
  const tailed = tailLines(filtered, lines);

  const titles = {
    all: "Sandbox logs (supervisor + Pi gateway)",
    supervisor: "Supervisor logs",
    serve: "Pi gateway logs",
  };

  return {
    lines: tailed,
    title: titles[source] || titles.all,
    running: sandbox.isContainerRunning(name),
    sandbox: name,
  };
}

export function fetchLogStatus(userId) {
  const name = sandboxNameForUser(userId);
  if (!name) throw new Error("No sandbox assigned.");

  const running = sandbox.isContainerRunning(name);
  const raw = sandbox.getContainerLogs(name, 80);
  const lines = raw.split("\n").filter((l) => l.length > 0);

  let lastStart = null;
  let lastExit = null;
  let lastHealth = null;
  let lastQuarantine = null;

  for (const line of lines) {
    if (line.includes("[supervisor] starting: pi") || line.includes("[supervisor] starting: opencode")) lastStart = line;
    if (line.includes("serve exited")) lastExit = line;
    if (line.includes("health probe")) lastHealth = line;
    if (line.includes("quarantined bad tool")) lastQuarantine = line;
  }

  const activity = getActivityLogs(userId, 3);
  const parts = [
    `**Sandbox:** \`${name}\``,
    `**Container:** ${running ? "✅ running" : "❌ not running"}`,
  ];
  if (lastHealth) parts.push(`**Last health check:** ${redactLogText(lastHealth.replace(/^\S+\s+/, ""))}`);
  if (lastStart) parts.push(`**Last serve start:** ${redactLogText(lastStart.replace(/^\S+\s+/, ""))}`);
  if (lastExit) parts.push(`**Last serve exit:** ${redactLogText(lastExit.replace(/^\S+\s+/, ""))}`);
  if (lastQuarantine) parts.push(`**Last quarantine:** ${redactLogText(lastQuarantine.replace(/^\S+\s+/, ""))}`);
  if (activity.length) {
    parts.push(`**Recent activity:**\n\`\`\`\n${redactLogText(activity.join("\n"))}\n\`\`\``);
  } else {
    parts.push("**Recent activity:** none yet this session");
  }

  return parts.join("\n");
}
