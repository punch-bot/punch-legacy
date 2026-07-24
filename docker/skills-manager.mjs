import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOTS = [
  { source: "workspace", directory: "/work/.pi/skills", writable: true },
  { source: "user", directory: "/data/pi/skills", writable: true },
  { source: "bundled", directory: "/opt/pi/skills", writable: false },
];
const ENABLED_FILE = "/data/pi/skills-enabled.json";
const PROPOSALS_DIR = "/data/pi/skill-proposals";
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } }
function atomicJson(file, value) { mkdirSync(resolve(file, ".."), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, file); }
function parseFrontmatter(text) {
  const match = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { metadata: {}, body: text };
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (item) metadata[item[1]] = item[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return { metadata, body: text.slice(match[0].length) };
}
function requirements(metadata) {
  const env = String(metadata.env || metadata.requires_env || "").split(",").map((x) => x.trim()).filter(Boolean);
  const binaries = String(metadata.binaries || metadata.requires_binaries || "").split(",").map((x) => x.trim()).filter(Boolean);
  return { env, binaries, missingEnv: env.filter((name) => !process.env[name]), missingBinaries: binaries.filter((name) => !binaryExists(name)) };
}
function binaryExists(binary) {
  if (!/^[a-zA-Z0-9._+-]+$/.test(binary)) return false;
  return ["/usr/local/bin", "/usr/bin", "/bin"].some((dir) => existsSync(join(dir, binary)));
}
function pathFor(root, name) { if (!NAME.test(name)) throw new Error("Invalid skill name"); return join(root.directory, name, "SKILL.md"); }
function enabledState() { return readJson(ENABLED_FILE, {}); }

export function listSkills() {
  const enabled = enabledState();
  const seen = new Set();
  const result = [];
  for (const root of ROOTS) {
    let entries = [];
    try { entries = readdirSync(root.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME.test(entry.name) || seen.has(entry.name)) continue;
      const file = join(root.directory, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        const parsed = parseFrontmatter(readFileSync(file, "utf8"));
        seen.add(entry.name);
        result.push({ name: entry.name, source: root.source, enabled: enabled[entry.name] !== false, description: parsed.metadata.description || "", metadata: parsed.metadata, requirements: requirements(parsed.metadata), mtime: statSync(file).mtimeMs });
      } catch {}
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function inspectSkill(name) {
  const skill = listSkills().find((entry) => entry.name === name);
  if (!skill) return null;
  const root = ROOTS.find((entry) => entry.source === skill.source);
  const file = pathFor(root, name);
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  return { ...skill, content: parsed.body.slice(0, 20_000) };
}

export function setSkillEnabled(name, enabled) {
  if (!listSkills().some((entry) => entry.name === name)) return null;
  const state = enabledState();
  state[name] = Boolean(enabled);
  atomicJson(ENABLED_FILE, state);
  return inspectSkill(name);
}

export function proposeSkill({ name, content }) {
  if (!NAME.test(name)) throw new Error("Invalid skill name");
  if (typeof content !== "string" || content.length < 1 || content.length > 40_000) throw new Error("Skill content must be 1-40000 characters");
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(PROPOSALS_DIR, `${id}.json`);
  atomicJson(file, { id, name, content, createdAt: Date.now() });
  return { id, name };
}

export function listProposals() {
  try { return readdirSync(PROPOSALS_DIR).filter((name) => name.endsWith(".json")).map((name) => readJson(join(PROPOSALS_DIR, name), null)).filter(Boolean).map(({ content, ...proposal }) => ({ ...proposal, size: content.length })).sort((a, b) => b.createdAt - a.createdAt); } catch { return []; }
}

export function reviewProposal(id, approve) {
  if (!/^[a-z0-9-]{6,80}$/i.test(id)) throw new Error("Invalid proposal id");
  const file = join(PROPOSALS_DIR, `${id}.json`);
  const proposal = readJson(file, null);
  if (!proposal) return null;
  if (approve) {
    const root = ROOTS[1];
    const destination = pathFor(root, proposal.name);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, proposal.content, { mode: 0o600 });
    renameSync(temporary, destination);
  }
  rmSync(file, { force: true });
  return { id, name: proposal.name, approved: Boolean(approve) };
}
