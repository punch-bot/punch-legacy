import { tool } from "@opencode-ai/plugin";

const BOT_URL = process.env.PUNCH_BOT_URL || "http://localhost:4097/bot";
const AUTH = "Basic " + Buffer.from("opencode:" + (process.env.PI_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");

async function botFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BOT_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: AUTH,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data;
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

export default tool({
  description: "Schedule Discord reminders, LLM automations, and heartbeat routines via Punch",
  args: {
    action: tool.schema.enum(["create", "list", "remove", "pause", "resume"]).describe("create, list, remove, pause, or resume a routine"),
    userId: tool.schema.string().describe("Discord user ID from [user:ID] tag"),
    channelId: tool.schema.string().optional().describe("Discord channel ID where the routine was requested (required for message/llm types)"),
    type: tool.schema.enum(["message", "llm", "heartbeat"]).optional().describe("message = static reminder, llm = run a prompt when it fires, heartbeat = autonomous LLM turn that DMs you results"),
    when: tool.schema.string().optional().describe("When to run (e.g. 30m, tomorrow 9am, every 6h)"),
    text: tool.schema.string().optional().describe("Reminder text or LLM prompt"),
    recurrence: tool.schema.string().optional().describe("once, daily, weekly, every 30m, every 2h, or cron expression"),
    timezone: tool.schema.string().optional().describe("IANA timezone for interpreting when (e.g. America/New_York)"),
    id: tool.schema.string().optional().describe("Routine id for remove/pause/resume"),
  },
  async execute(args) {
    if (args.action === "list") {
      const data = await botFetch(`/routines/list?userId=${encodeURIComponent(args.userId)}`);
      return JSON.stringify(data.routines || [], null, 2);
    }

    if (args.action === "remove") {
      if (!args.id) throw new Error("id is required for remove");
      const data = await botFetch(`/routines/${encodeURIComponent(args.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ userId: args.userId }),
      });
      return JSON.stringify(data, null, 2);
    }

    if (args.action === "pause") {
      if (!args.id) throw new Error("id is required for pause");
      const data = await botFetch(`/routines/${encodeURIComponent(args.id)}/pause`, {
        method: "POST",
        body: JSON.stringify({ userId: args.userId }),
      });
      return JSON.stringify(data, null, 2);
    }

    if (args.action === "resume") {
      if (!args.id) throw new Error("id is required for resume");
      const data = await botFetch(`/routines/${encodeURIComponent(args.id)}/resume`, {
        method: "POST",
        body: JSON.stringify({ userId: args.userId }),
      });
      return JSON.stringify(data, null, 2);
    }

    // create
    const routineType = args.type || "message";
    if (routineType !== "heartbeat" && !args.channelId) {
      throw new Error("channelId is required for create (except heartbeat type)");
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
    return JSON.stringify(data.routine, null, 2);
  },
});
