import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as sandbox from "./sandbox-manager.js";

const FILE = "/data/collabs.json";
const ID_PATTERN = /^col_[a-f0-9]{12}$/;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/;

function load() {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(records) {
  writeFileSync(FILE, JSON.stringify(records, null, 2), { mode: 0o600 });
}

function collabOrThrow(id) {
  if (!ID_PATTERN.test(String(id || ""))) throw new Error("Invalid collaboration ID.");
  const collab = load().find((record) => record.id === id);
  if (!collab) throw new Error("Collaboration not found.");
  return collab;
}

function requireParticipant(collab, actor) {
  if (!collab.participants.includes(actor)) throw new Error("Sandbox is not a collaboration participant.");
}

function write(collab) {
  const records = load();
  const index = records.findIndex((record) => record.id === collab.id);
  if (index < 0) throw new Error("Collaboration not found.");
  records[index] = collab;
  save(records);
}

function safeWorkspace(path) {
  if (typeof path !== "string" || !path.startsWith("/work/") || path.includes("\0")) {
    throw new Error("Workspace must be an absolute path under /work.");
  }
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "/work") throw new Error("Workspace must be a project directory below /work.");
  return normalized;
}

async function bareHead(collab, branch) {
  const { stdout } = await sandbox.gitInSandbox(collab.owner, ["--git-dir", collab.repo, "rev-parse", `refs/heads/${branch}`]);
  return stdout.toLowerCase();
}

export function listFor(actor) {
  return load().filter((collab) => collab.participants.includes(actor));
}

export function getFor(id, actor) {
  const collab = collabOrThrow(id);
  requireParticipant(collab, actor);
  return collab;
}

export async function create({ owner, reviewer, workspace }) {
  if (!sandbox.isValidSandboxName(reviewer) || reviewer === owner) throw new Error("Reviewer must be another valid sandbox name.");
  if (!sandbox.loadUsers().some((user) => user.name === reviewer)) throw new Error("Reviewer sandbox is not registered.");
  const source = safeWorkspace(workspace);
  const id = `col_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const repo = `/collab/${id}.git`;
  const clonePath = `/work/collab/${id}`;
  let hasRepository = true;
  try {
    await sandbox.gitInSandbox(owner, ["-C", source, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    hasRepository = false;
  }
  if (!hasRepository) {
    await sandbox.gitInSandbox(owner, ["init", "--initial-branch=main", source]);
  }
  let hasHead = true;
  try {
    await sandbox.gitInSandbox(owner, ["-C", source, "rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    // Fresh prompt-created workspaces need an initial commit before Git can clone them.
    await sandbox.gitInSandbox(owner, ["-C", source, "config", "user.name", `Punch ${owner}`]);
    await sandbox.gitInSandbox(owner, ["-C", source, "config", "user.email", `${owner}@punch.local`]);
    await sandbox.gitInSandbox(owner, ["-C", source, "add", "--all"]);
    await sandbox.gitInSandbox(owner, ["-C", source, "commit", "--allow-empty", "--message", "Initialize collaboration"]);
  }
  await sandbox.gitInSandbox(owner, ["clone", "--bare", source, repo]);
  const { stdout: base } = await sandbox.gitInSandbox(owner, ["--git-dir", repo, "rev-parse", "HEAD"]);
  await sandbox.gitInSandbox(owner, ["--git-dir", repo, "update-ref", "refs/heads/main", base]);
  await sandbox.gitInSandbox(owner, ["-C", source, "remote", "remove", "punch-collab"]).catch(() => {});
  await sandbox.gitInSandbox(owner, ["-C", source, "remote", "add", "punch-collab", repo]);
  await sandbox.gitInSandbox(reviewer, ["clone", repo, clonePath]);
  const collab = { id, owner, participants: [owner, reviewer], repo, baseRef: "main", base: base.toLowerCase(), workspaces: { [owner]: source, [reviewer]: clonePath }, proposal: null, createdAt: Date.now(), updatedAt: Date.now() };
  const records = load();
  records.push(collab);
  save(records);
  return collab;
}

export async function propose({ id, actor, head }) {
  const collab = collabOrThrow(id);
  requireParticipant(collab, actor);
  if (!SHA_PATTERN.test(String(head || ""))) throw new Error("Head must be a full Git SHA.");
  const branch = `changes/${id}`;
  const remoteHead = await bareHead(collab, branch);
  if (remoteHead !== head.toLowerCase()) throw new Error("Proposal SHA is not current collaboration branch head.");
  try { await sandbox.gitInSandbox(collab.owner, ["--git-dir", collab.repo, "merge-base", "--is-ancestor", collab.base, remoteHead]); }
  catch { throw new Error("Proposal does not descend from canonical main."); }
  const reviewer = collab.participants.find((name) => name !== actor);
  collab.proposal = { branch, author: actor, reviewer, head: remoteHead, authorApprovedAt: Date.now(), reviewerApprovedAt: null, reviewedHead: null, reviewNotes: "", status: "pending_review" };
  collab.updatedAt = Date.now();
  write(collab);
  return collab;
}

export async function review({ id, actor, approve, notes = "" }) {
  const collab = collabOrThrow(id);
  requireParticipant(collab, actor);
  const proposal = collab.proposal;
  if (!proposal || proposal.status === "merged") throw new Error("No proposal awaiting review.");
  if (actor !== proposal.reviewer) throw new Error("Only other participant may review this proposal.");
  const remoteHead = await bareHead(collab, proposal.branch);
  if (remoteHead !== proposal.head) throw new Error("Branch changed. Author must propose new SHA again.");
  proposal.reviewNotes = String(notes).slice(0, 4000);
  proposal.reviewedHead = remoteHead;
  proposal.reviewerApprovedAt = approve ? Date.now() : null;
  proposal.status = approve ? "approved" : "changes_requested";
  collab.updatedAt = Date.now();
  write(collab);
  if (approve) await mergeIfApproved(collab);
  return collabOrThrow(id);
}

export async function mergeIfApproved(collab) {
  const proposal = collab.proposal;
  if (!proposal?.authorApprovedAt || !proposal.reviewerApprovedAt || proposal.reviewedHead !== proposal.head) return false;
  const remoteHead = await bareHead(collab, proposal.branch);
  if (remoteHead !== proposal.head) return false;
  try { await sandbox.gitInSandbox(collab.owner, ["--git-dir", collab.repo, "merge-base", "--is-ancestor", collab.base, remoteHead]); }
  catch { throw new Error("Cannot auto-merge: canonical main and proposal diverged."); }
  await sandbox.gitInSandbox(collab.owner, ["--git-dir", collab.repo, "update-ref", "refs/heads/main", remoteHead, collab.base]);
  collab.base = remoteHead;
  proposal.status = "merged";
  proposal.mergedAt = Date.now();
  collab.updatedAt = Date.now();
  write(collab);
  return true;
}
