import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || "/data";
export const USERS_FILE = `${DATA_DIR}/sandbox_users.json`;
const DOCTOR_TOKENS_FILE = `${DATA_DIR}/sandbox_doctor_tokens.json`;
const BOT_TOKENS_FILE = `${DATA_DIR}/sandbox_bot_tokens.json`;
const MAIN_COMPOSE = "/punch/docker-compose.yml";
const STACK = process.env.PUNCH_STACK_NAME || "punch";
const NETWORK = `${STACK}_edge`;
const VOL_PREFIX = `${STACK}_`;
const SANDBOX_IMAGE = process.env.PUNCH_SANDBOX_IMAGE || "punch-sandbox:latest";

function vol(name) {
  return VOL_PREFIX + name;
}

const SANDBOX_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

export function isValidSandboxName(name) {
  return typeof name === "string" && SANDBOX_NAME_PATTERN.test(name);
}

function validateSandboxName(name) {
  if (!isValidSandboxName(name)) {
    throw new Error("Sandbox name must be 1-63 lowercase letters, digits, or hyphens, and cannot start with a hyphen.");
  }
}

export function loadUsers() {
  try {
    return JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadDoctorTokens() {
  try {
    const tokens = JSON.parse(readFileSync(DOCTOR_TOKENS_FILE, "utf8"));
    return tokens && typeof tokens === "object" && !Array.isArray(tokens) ? tokens : {};
  } catch {
    return {};
  }
}

function saveDoctorTokens(tokens) {
  writeFileSync(DOCTOR_TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function loadBotTokens() {
  try {
    const tokens = JSON.parse(readFileSync(BOT_TOKENS_FILE, "utf8"));
    return tokens && typeof tokens === "object" && !Array.isArray(tokens) ? tokens : {};
  } catch {
    return {};
  }
}

function saveBotTokens(tokens) {
  writeFileSync(BOT_TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function doctorTokenFor(name) {
  validateSandboxName(name);
  const tokens = loadDoctorTokens();
  if (!tokens[name]) {
    tokens[name] = randomBytes(32).toString("base64url");
    saveDoctorTokens(tokens);
  }
  return tokens[name];
}

export function botTokenFor(name) {
  validateSandboxName(name);
  const tokens = loadBotTokens();
  if (!tokens[name]) {
    tokens[name] = randomBytes(32).toString("base64url");
    saveBotTokens(tokens);
  }
  return tokens[name];
}

export function resolveBotToken(token) {
  if (!token) return null;
  const tokens = loadBotTokens();
  const name = Object.keys(tokens).find((n) => tokens[n] === token);
  if (!name) return null;
  const user = loadUsers().find((u) => u.name === name);
  return user ? { name, userId: user.userId } : null;
}

export function addUser(name, userId) {
  if (!isValidSandboxName(name)) {
    return { ok: false, error: "Sandbox name must be 1-63 lowercase letters, digits, or hyphens, and cannot start with a hyphen." };
  }
  const users = loadUsers();
  if (users.find((u) => u.name === name)) return { ok: false, error: `User "${name}" already exists.` };
  if (users.find((u) => u.userId === userId)) return { ok: false, error: `User ID ${userId} already mapped.` };
  users.push({ name, userId });
  saveUsers(users);
  return { ok: true };
}

export function removeUser(name) {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.name === name);
  if (idx < 0) return { ok: false, error: `User "${name}" not found.` };
  const removed = users.splice(idx, 1)[0];
  saveUsers(users);
  const tokens = loadDoctorTokens();
  if (tokens[name]) {
    delete tokens[name];
    saveDoctorTokens(tokens);
  }
  const botTokens = loadBotTokens();
  if (botTokens[name]) {
    delete botTokens[name];
    saveBotTokens(botTokens);
  }
  return { ok: true, removed };
}

function userEnvArgs(name) {
  const user = loadUsers().find((u) => u.name === name);
  return [
    "--env", `SANDBOX_NAME=${name}`,
    "--env", `SANDBOX_USER_ID=${user?.userId || ""}`,
    "--env", `PI_SERVER_USERNAME=${process.env.PI_SERVER_USERNAME || "pi"}`,
    "--env", `PI_SERVER_PASSWORD=${process.env.PI_SERVER_PASSWORD || ""}`,
    "--env", `PI_MODEL=${process.env.PI_MODEL || "opencode/big-pickle"}`,
    "--env", `PUNCH_DOCTOR_TOKEN=${doctorTokenFor(name)}`,
    "--env", `PUNCH_BOT_TOKEN=${botTokenFor(name)}`,
    ...["PI_HARD_TIMEOUT", "PI_IDLE_TIMEOUT"]
      .filter((key) => process.env[key])
      .flatMap((key) => ["--env", `${key}=${process.env[key]}`]),
  ];
}

function volumeArgs(name) {
  return [
    "--volume", `${vol("sandbox_home_" + name)}:/root`,
    "--volume", `${vol("sandbox_work_" + name)}:/work`,
    "--volume", `${vol("octl_data_" + name)}:/data`,
    "--volume", `${vol("ts_state_" + name)}:/var/lib/tailscale`,
    "--volume", `${vol("collab")}:/collab`,
  ];
}

const CONTAINER_NAME = (name) => `${STACK}_sandbox-${name}_1`;

export function getContainerDiagnostics(name) {
  validateSandboxName(name);
  const raw = execFileSync("docker", ["inspect", CONTAINER_NAME(name)], {
    timeout: 10000,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const [container] = JSON.parse(raw);
  if (!container) throw new Error("Docker inspect returned no container data");

  let expectedImageId = null;
  try {
    expectedImageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", SANDBOX_IMAGE], {
      timeout: 10000,
      encoding: "utf8",
    }).trim() || null;
  } catch {}

  const mounts = (container.Mounts || []).map((mount) => ({
    destination: mount.Destination,
    name: mount.Name || null,
    rw: mount.RW !== false,
  }));
  const devices = (container.HostConfig?.Devices || []).map((device) => device.PathOnHost);
  const capabilities = container.HostConfig?.CapAdd || [];
  const networks = Object.keys(container.NetworkSettings?.Networks || {});
  return {
    name: container.Name?.replace(/^\//, "") || CONTAINER_NAME(name),
    running: container.State?.Running === true,
    status: container.State?.Status || "unknown",
    health: container.State?.Health?.Status || null,
    oomKilled: container.State?.OOMKilled === true,
    restartCount: Number(container.RestartCount) || 0,
    startedAt: container.State?.StartedAt || null,
    image: container.Config?.Image || null,
    imageId: container.Image || null,
    expectedImage: SANDBOX_IMAGE,
    expectedImageId,
    imageMatches: Boolean(expectedImageId && container.Image === expectedImageId),
    mounts,
    expectedMounts: {
      "/root": vol("sandbox_home_" + name),
      "/work": vol("sandbox_work_" + name),
      "/data": vol("octl_data_" + name),
      "/var/lib/tailscale": vol("ts_state_" + name),
      "/collab": vol("collab"),
    },
    devices,
    capabilities,
    networks,
    expectedNetwork: NETWORK,
  };
}

export function isContainerRunning(name) {
  try {
    return getContainerDiagnostics(name).running;
  } catch {
    return false;
  }
}

export async function restartContainer(name) {
  try {
    validateSandboxName(name);
    const { stdout } = await execFileAsync("docker", ["restart", "--time", "10", CONTAINER_NAME(name)], { timeout: 30000 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.stderr?.trim() || err.message };
  }
}

export function getContainerLogs(name, tail = 50) {
  validateSandboxName(name);
  const n = Math.max(1, Math.min(Number(tail) || 50, 500));
  const result = spawnSync("docker", ["logs", "--tail", String(n), CONTAINER_NAME(name)], {
    timeout: 15000,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (!result.error && result.status === 0) return output;

  const message = output.trim() || result.error?.message || "unknown error";
  if (/No such container/i.test(message)) {
    throw new Error("Sandbox container not found. Ask an admin to restart your sandbox.");
  }
  throw new Error(message);
}

export async function gitInSandbox(name, args, { cwd } = {}) {
  validateSandboxName(name);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Git arguments must be strings.");
  }
  const container = containerForSandbox(name);
  if (!container) throw new Error(`Sandbox "${name}" is not running.`);
  const command = ["exec"];
  if (cwd) command.push("--workdir", cwd);
  command.push(container, "git", ...args);
  try {
    const { stdout, stderr } = await execFileAsync("docker", command, { timeout: 30000 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message || "Git command failed.");
  }
}

async function removeContainer(name) {
  const targets = [];
  for (const candidate of containerCandidates(name)) {
    try {
      const out = execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", candidate], {
        timeout: 5000,
        encoding: "utf8",
      }).trim();
      if (out === "true" || out === "false") targets.push(candidate);
    } catch (err) {
      const message = err.stderr?.trim() || err.message || "";
      if (/No such (object|container)/i.test(message)) continue;
      throw new Error(`Failed to inspect sandbox container ${candidate}: ${message}`);
    }
  }
  if (targets.length === 0) return { stdout: "", stderr: "" };
  try {
    return await execFileAsync("docker", ["rm", "--force", ...targets], { timeout: 15000 });
  } catch (err) {
    const message = err.stderr?.trim() || err.message || "";
    if (/No such container/i.test(message)) return { stdout: "", stderr: "" };
    throw err;
  }
}

export async function buildSandboxImage() {
  if (!existsSync(MAIN_COMPOSE)) return { ok: false, error: "Main compose file not found at " + MAIN_COMPOSE };
  try {
    await execFileAsync("docker", ["build", "--tag", SANDBOX_IMAGE, "--file", "/punch/docker/sandbox.Dockerfile", "/punch"], { timeout: 120000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.stderr?.trim() || err.message };
  }
}

async function runSandboxContainer(name) {
  const volumeNames = ["sandbox_home_" + name, "sandbox_work_" + name, "octl_data_" + name, "ts_state_" + name, "collab"];
  for (const volumeName of volumeNames) {
    await execFileAsync("docker", ["volume", "create", vol(volumeName)], { timeout: 10000 });
  }
  const { stdout } = await execFileAsync("docker", sandboxRunArgs(name), { timeout: 60000 });
  return { ok: true, output: stdout.trim() };
}

export function sandboxRunArgs(name) {
  validateSandboxName(name);
  return [
    "run", "--detach",
    "--name", CONTAINER_NAME(name),
    "--network", NETWORK,
    "--network-alias", `sandbox-${name}`,
    ...userEnvArgs(name),
    "--device", "/dev/net/tun",
    "--cap-add", "NET_ADMIN",
    "--pids-limit", "512",
    "--memory", "4g",
    "--cpus", "3",
    ...volumeArgs(name),
    "--restart", "unless-stopped",
    SANDBOX_IMAGE,
  ];
}

export async function composeUp(name) {
  if (!existsSync(MAIN_COMPOSE)) return { ok: false, error: "Main compose file not found at " + MAIN_COMPOSE };
  try {
    validateSandboxName(name);
    await removeContainer(name);
    const build = await buildSandboxImage();
    if (!build.ok) return build;
    return await runSandboxContainer(name);
  } catch (err) {
    return { ok: false, error: err.stderr?.trim() || err.message };
  }
}

export async function restartAllSandboxes({ recreate = false } = {}) {
  const users = loadUsers();
  if (users.length === 0) return { ok: false, error: "No sandbox users configured. Use /sandbox create first." };

  const results = [];
  let failures = 0;
  for (const user of users) {
    try {
      validateSandboxName(user.name);
      if (recreate) {
        await removeContainer(user.name);
        const run = await runSandboxContainer(user.name);
        if (!run.ok) {
          failures++;
          results.push({ name: user.name, ok: false, error: run.error });
          continue;
        }
        results.push({ name: user.name, ok: true, output: run.output });
      } else {
        const container = containerForSandbox(user.name) || CONTAINER_NAME(user.name);
        if (!container) throw new Error("sandbox container not found");
        const { stdout } = await execFileAsync("docker", ["restart", "--time", "10", container], { timeout: 30000 });
        results.push({ name: user.name, ok: true, output: stdout.trim() });
      }
    } catch (err) {
      failures++;
      results.push({ name: user.name, ok: false, error: err.stderr?.trim() || err.message });
    }
  }
  return { ok: failures === 0, results };
}

export async function composeDown(name) {
  try {
    validateSandboxName(name);
    const { stdout } = await removeContainer(name);
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.stderr?.trim() || err.message };
  }
}

function containerCandidates(name) {
  const candidates = [
    `${STACK}_sandbox-${name}_1`,
    `${STACK}-sandbox-${name}-1`,
  ];
  for (let i = 1; i <= 9; i++) candidates.push(`${STACK}-sandbox-${name}-${i}`);
  return candidates;
}

export function containerForSandbox(name) {
  if (!isValidSandboxName(name)) return null;
  for (const candidate of containerCandidates(name)) {
    try {
      const out = execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", candidate], {
        timeout: 5000,
        encoding: "utf8",
      }).trim();
      if (out === "true") return candidate;
    } catch {}
  }
  return null;
}

export function ensureDirInContainer(container, dir) {
  execFileSync("docker", ["exec", container, "mkdir", "--parents", dir], { timeout: 10000, encoding: "utf8" });
}

export function copyIntoContainer(container, localPath, remotePath) {
  execFileSync("docker", ["cp", localPath, `${container}:${remotePath}`], { timeout: 30000, encoding: "utf8" });
}
