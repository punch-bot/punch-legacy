import * as sandbox from "./sandbox-manager.js";
import * as store from "./memory.js";
import { assessAgentPigeon, scanOutbound } from "./pigeon-supervisor.js";

const SUMMARY_MAX = 500;

function userIdForSandboxName(name) {
  if (!name) return null;
  return sandbox.loadUsers().find((u) => u.name === name)?.userId || null;
}

function truncate(text, max = SUMMARY_MAX) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

async function postPigeonToSandbox(targetSandbox, body) {
  const url = `http://sandbox-${targetSandbox}:4097/pigeon`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`pigeon POST ${res.status}: ${t.slice(0, 120)}`);
  }
}

export async function notifyPigeonDone({
  recipientUserId,
  pigeonFrom,
  pigeonHop,
  sandboxName,
  status,
  summary = "",
  error = "",
  notifyPigeonDM,
}) {
  const us = store.getUserSettings(recipientUserId);
  const any =
    us.pigeonDonePigeon || us.pigeonDoneDm || us.pigeonDoneAgent;
  if (!any || !pigeonFrom) return;

  const fromName = sandboxName || "unknown";
  const hopNum = Number(pigeonHop) || 0;
  const nextHop = hopNum + 1;

  let headline;
  let bodyText;
  if (status === "done") {
    headline = "done";
    bodyText = truncate(summary) || "(no text output)";
  } else if (status === "cancelled") {
    headline = "cancelled";
    bodyText = "The agent pigeon task was cancelled before completion.";
  } else {
    headline = "failed";
    bodyText = truncate(error || summary || "unknown error", 300);
  }

  const pigeonText = `[agent pigeon ${headline}] ${fromName} finished your request (hop ${hopNum}): ${bodyText}`;
  const dmText = `📬 **Agent pigeon ${headline}** — **${fromName}** finished the task you sent via agent pigeon.\n\n${bodyText}`;
  const safePigeonText = scanOutbound(pigeonText).text;

  const senderUserId = userIdForSandboxName(pigeonFrom);
  const tasks = [];

  if (us.pigeonDonePigeon) {
    tasks.push(
      postPigeonToSandbox(pigeonFrom, { from: fromName, text: safePigeonText }).catch((err) => {
        console.error(`[pigeon-done] normal pigeon to ${pigeonFrom} failed:`, err.message);
      }),
    );
  }

  if (us.pigeonDoneDm && senderUserId && notifyPigeonDM) {
    tasks.push(
      notifyPigeonDM(senderUserId, fromName, `**Agent pigeon ${headline}**\n\n${bodyText}`).catch((err) => {
        console.error(`[pigeon-done] DM to ${senderUserId} failed:`, err.message);
      }),
    );
  }

  if (us.pigeonDoneAgent) {
    const assessment = assessAgentPigeon({ text: safePigeonText, from: fromName, hop: nextHop });
    if (assessment.allow) {
      tasks.push(
        postPigeonToSandbox(pigeonFrom, {
          from: fromName,
          text: safePigeonText,
          agent: true,
          hop: nextHop,
        }).catch((err) => {
          console.error(`[pigeon-done] agent pigeon to ${pigeonFrom} failed:`, err.message);
        }),
      );
    } else {
      console.warn(`[pigeon-done] agent pigeon back blocked: ${assessment.reason}`);
    }
  }

  await Promise.all(tasks);
  console.log(
    `[pigeon-done] ${headline} uid=${recipientUserId} -> ${pigeonFrom} pigeon=${!!us.pigeonDonePigeon} dm=${!!us.pigeonDoneDm} agent=${!!us.pigeonDoneAgent}`,
  );
}
