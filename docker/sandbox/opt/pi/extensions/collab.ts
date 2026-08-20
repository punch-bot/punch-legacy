import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const BOT_URL = process.env.PUNCH_BOT_URL || "http://localhost:4097/bot";
const AUTH = "Basic " + Buffer.from(`opencode:${process.env.PI_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");

async function botFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BOT_URL}${path}`, { ...init, headers: { "content-type": "application/json", authorization: AUTH, ...(init.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status}`);
  return data;
}

function git(workspace: string, args: string[]) {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "collab",
    label: "Punch collaboration",
    description: "Propose, fetch, and review a two-agent Git collaboration. Canonical main auto-merges only after both agents approve the same SHA.",
    promptSnippet: "Use collab for shared cross-sandbox code review",
    promptGuidelines: ["Before approving, fetch exact proposed SHA, inspect diff, and run relevant tests.", "Any change needs a new proposal and a fresh review."],
    parameters: Type.Object({
      action: StringEnum(["start", "list", "status", "propose", "review"] as const),
      id: Type.Optional(Type.String({ description: "Collaboration ID" })),
      reviewer: Type.Optional(Type.String({ description: "Other registered sandbox name, for start" })),
      workspace: Type.Optional(Type.String({ description: "Local collaboration workspace under /work" })),
      task: Type.Optional(Type.String({ description: "Work request sent to peer agent, for start" })),
      approve: Type.Optional(Type.Boolean({ description: "For review: true to approve, false to request changes" })),
      notes: Type.Optional(Type.String({ description: "Review findings or approval summary" })),
    }),
    async execute(_toolCallId, args) {
      if (args.action === "start") {
        if (!args.reviewer || !args.workspace) throw new Error("reviewer and workspace are required to start");
        const data = await botFetch("/collabs/create", { method: "POST", body: JSON.stringify({ reviewer: args.reviewer, workspace: args.workspace, task: args.task || "" }) });
        return { content: [{ type: "text" as const, text: `Started ${data.collab.id}. Git repository ready at ${args.workspace}; peer clone: ${data.collab.workspaces[args.reviewer] || "created"}.` }] };
      }
      if (args.action === "list") {
        const data = await botFetch("/collabs");
        return { content: [{ type: "text" as const, text: JSON.stringify(data.collabs, null, 2) }] };
      }
      if (!args.id) throw new Error("id is required");
      if (args.action === "status") {
        const data = await botFetch(`/collabs/${encodeURIComponent(args.id)}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(data.collab, null, 2) }] };
      }
      const status = await botFetch(`/collabs/${encodeURIComponent(args.id)}`);
      const collab = status.collab;
      const workspace = args.workspace || collab.workspaces[process.env.SANDBOX_NAME || ""];
      if (!workspace) throw new Error("workspace is required");
      const branch = `changes/${args.id}`;
      if (args.action === "propose") {
        try { git(workspace, ["remote", "set-url", "punch-collab", collab.repo]); }
        catch { git(workspace, ["remote", "add", "punch-collab", collab.repo]); }
        const head = git(workspace, ["rev-parse", "HEAD"]);
        git(workspace, ["push", "punch-collab", `HEAD:refs/heads/${branch}`]);
        const data = await botFetch(`/collabs/${encodeURIComponent(args.id)}/propose`, { method: "POST", body: JSON.stringify({ head }) });
        return { content: [{ type: "text" as const, text: `Proposed ${head}. Review requested from ${data.collab.proposal.reviewer}.` }] };
      }
      git(workspace, ["fetch", "origin", branch]);
      const proposed = collab.proposal;
      if (!proposed) throw new Error("No proposal awaiting review.");
      const data = await botFetch(`/collabs/${encodeURIComponent(args.id)}/review`, { method: "POST", body: JSON.stringify({ approve: args.approve === true, notes: args.notes || "" }) });
      return { content: [{ type: "text" as const, text: data.collab.proposal.status === "merged" ? "Approved. Matching approvals auto-merged into main." : args.approve ? "Approved. Awaiting auto-merge." : "Changes requested." }] };
    },
  });
}
