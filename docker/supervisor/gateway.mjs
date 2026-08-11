// Pi gateway child-process lifecycle: spawn, health probe, quarantine, reload, watchers.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import {
  DEBOUNCE_MS,
  HEALTHY_MS,
  PROBE_AUTH,
  PROBE_URL,
  TOOL_DIRS,
  WORK,
  log,
  sleep,
  state,
} from "./state.mjs";

export function toolFiles() {
  const files = [];
  for (const dir of TOOL_DIRS) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === ".broken") continue;
      if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
      const full = join(dir, name);
      try {
        files.push({ dir, name, full, mtime: statSync(full).mtimeMs });
      } catch {
        // raced deletion
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

export function toolSetHash() {
  const h = createHash("sha1");
  for (const f of toolFiles().sort((a, b) => a.full.localeCompare(b.full))) {
    try {
      h.update(f.full).update("\0").update(readFileSync(f.full));
    } catch {
      // raced deletion
    }
  }
  return h.digest("hex");
}

export function quarantineNewest() {
  const [newest] = toolFiles();
  if (!newest) {
    log("nothing to quarantine (no tool files); serve keeps failing on its own");
    return false;
  }
  const dest = join(newest.dir, ".broken", newest.name);
  try {
    renameSync(newest.full, dest);
    log(`quarantined bad tool -> ${dest}`);
    return true;
  } catch (e) {
    log("quarantine failed:", e.message);
    return false;
  }
}

export function start() {
  state.restarting = false;
  state.startedAt = Date.now();
  const gen = ++state.generation;
  state.loadedHash = toolSetHash();
  log("starting: pi-gateway (model", state.CURRENT_MODEL + ")");
  const gatewayEnv = { ...process.env };
  delete gatewayEnv.PUNCH_DOCTOR_TOKEN;
  const child = spawn("node", ["/usr/local/bin/pi-gateway.mjs"], {
    stdio: "inherit",
    env: {
      ...gatewayEnv,
      PI_DEFAULT_MODEL: state.CURRENT_MODEL,
      PI_MODEL: state.CURRENT_MODEL,
      PI_EXTENSIONS_DIR: "/opt/pi/extensions",
      PI_SESSION_DIR: "/data/pi/sessions",
      PI_REMOTE_DIR: WORK,
    },
  });

  const spawnedChild = child;
  spawnedChild.on("exit", (code, signal) => {
    const uptime = Date.now() - state.startedAt;
    log(`pi-gateway exited code=${code} signal=${signal} uptime=${uptime}ms`);
    if (state.child === spawnedChild) state.child = null;

    if (state.restarting) return;

    if (state.armedForQuarantine && uptime < HEALTHY_MS) {
      state.armedForQuarantine = false;
      quarantineNewest();
    }
    setTimeout(start, 1000);
  });

  state.child = child;
  probeHealth(gen);
}

export async function probeHealth(gen) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (gen !== state.generation) return;
    let status;
    try {
      const res = await fetch(PROBE_URL, { headers: { authorization: PROBE_AUTH } });
      status = res.status;
    } catch {
      await sleep(500);
      continue;
    }
    if (gen !== state.generation) return;
    if (status === 500) {
      log("health probe 500 -> tool set is poisoned");
      state.armedForQuarantine = false;
      if (quarantineNewest()) forceRestart();
      else log("could not quarantine; leaving gateway up (may keep 500ing)");
      return;
    }
    if (status !== 200) {
      await sleep(500);
      continue;
    }
    state.armedForQuarantine = false;
    log(`health probe ${status} -> gateway OK`);
    return;
  }
  log("health probe timed out waiting for serve");
}

export function forceRestart() {
  if (state.restarting) return;
  if (!state.child) {
    start();
    return;
  }
  state.restarting = true;
  const dying = state.child;
  dying.once("exit", start);
  dying.kill("SIGTERM");
  setTimeout(() => {
    try { dying.kill("SIGKILL"); } catch {}
  }, 4000);
}

export function restartForReload() {
  if (!state.child || state.restarting) return;

  if (toolSetHash() === state.loadedHash) {
    log("watch fired but tool content unchanged -> skip reload");
    return;
  }
  state.restarting = true;
  state.armedForQuarantine = true;
  log("extension/tool change detected -> reloading pi-gateway");
  const dying = state.child;
  dying.once("exit", start);
  dying.kill("SIGTERM");
  setTimeout(() => { try { dying.kill("SIGKILL"); } catch {} }, 4000);
}

export function scheduleReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(restartForReload, DEBOUNCE_MS);
}

export function setupWatchers() {
  for (const dir of TOOL_DIRS) {
    watch(dir, (_event, filename) => {
      if (!filename) return;
      if (String(filename).startsWith(".broken")) return;
      if (!/\.(ts|js|mjs|cjs)$/.test(filename)) return;
      log(`change: ${dir}/${filename}`);
      scheduleReload();
    });
  }
}

export function setupSignalHandlers() {
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      log(`got ${sig}, shutting down`);
      state.restarting = true;
      if (state.child) state.child.kill(sig);
      process.exit(0);
    });
  }
}
