import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const BOT_URL = process.env.PUNCH_BOT_URL || "http://bot:4098";
// Basic-auth username defaults to legacy wire alias "opencode" — not the agent runtime.
const AUTH =
  "Basic " +
  Buffer.from(
    `${process.env.PI_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.PI_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || ""}`,
  ).toString("base64");

async function botFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BOT_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: AUTH,
      "x-discord-user-id": process.env.SANDBOX_USER_ID || "",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${text}`);
  }
  return data;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "routines",
    label: "Punch routines",
    description:
      "Schedule Discord reminders, LLM automations, and heartbeat routines via Punch",
    promptSnippet: "Create/list/pause Discord reminders and heartbeat routines",
    promptGuidelines: [
      "Use routines when the user asks for a reminder, recurring ping, or heartbeat automation.",
    ],
    parameters: Type.Object({
      action: StringEnum(["create", "list", "remove", "pause", "resume"] as const),
      userId: Type.String({
        description: "Discord user ID from speaker tag id:NUMBER",
      }),
      channelId: Type.Optional(
        Type.String({
          description:
            "Discord channel ID where the routine was requested (required for message/llm types)",
        }),
      ),
      type: Type.Optional(StringEnum(["message", "llm", "heartbeat"] as const)),
      when: Type.Optional(
        Type.String({
          description: "When to run (e.g. 30m, tomorrow 9am, every 6h)",
        }),
      ),
      text: Type.Optional(
        Type.String({ description: "Reminder text or LLM prompt" }),
      ),
      recurrence: Type.Optional(
        Type.String({
          description:
            "once, daily, weekly, every 30m, every 2h, or cron expression",
        }),
      ),
      timezone: Type.Optional(
        Type.String({
          description:
            "IANA timezone for interpreting when (e.g. America/New_York). Prefer the user's /settings timezone.",
        }),
      ),
      id: Type.Optional(
        Type.String({ description: "Routine id for remove/pause/resume" }),
      ),
    }),

    async execute(_toolCallId, args) {
      if (args.action === "list") {
        const data = await botFetch(
          `/routines/list?userId=${encodeURIComponent(args.userId)}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data.routines || [], null, 2),
            },
          ],
        };
      }

      if (args.action === "remove") {
        if (!args.id) throw new Error("id is required for remove");
        const data = await botFetch(`/routines/${encodeURIComponent(args.id)}`, {
          method: "DELETE",
          body: JSON.stringify({ userId: args.userId }),
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      }

      if (args.action === "pause") {
        if (!args.id) throw new Error("id is required for pause");
        const data = await botFetch(
          `/routines/${encodeURIComponent(args.id)}/pause`,
          {
            method: "POST",
            body: JSON.stringify({ userId: args.userId }),
          },
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      }

      if (args.action === "resume") {
        if (!args.id) throw new Error("id is required for resume");
        const data = await botFetch(
          `/routines/${encodeURIComponent(args.id)}/resume`,
          {
            method: "POST",
            body: JSON.stringify({ userId: args.userId }),
          },
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      }

      const routineType = args.type || "message";
      if (routineType !== "heartbeat" && !args.channelId) {
        throw new Error(
          "channelId is required for create (except heartbeat type)",
        );
      }
      if (!args.text) throw new Error("text is required for create");
      if (!args.when) throw new Error("when is required for create");

      const data = await botFetch("/routines/create", {
        method: "POST",
        body: JSON.stringify({
          userId: args.userId,
          channelId: args.channelId || null,
          type: routineType,
          payload: args.text,
          when: args.when,
          recurrence: args.recurrence || "once",
          timezone: args.timezone || null,
        }),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data.routine, null, 2),
          },
        ],
      };
    },
  });
}
