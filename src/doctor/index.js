const STATUSES = new Set(["pass", "warn", "fail", "info"]);
const CHECK_TIMEOUT_MS = 5_000;

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function check(id, status, title, message, durationMs, fix) {
  const result = {
    id: String(id),
    status: STATUSES.has(status) ? status : "info",
    title: String(title),
    message: String(message),
    durationMs: Math.max(0, Number(durationMs) || 0),
  };
  if (fix) result.fix = String(fix);
  return result;
}

async function withTimeout(operation, timeoutMs = CHECK_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function envValue(env, key) {
  if (env && typeof env.get === "function") return env.get(key);
  return env?.[key];
}

function authHeaders(env, doctorToken) {
  const username = envValue(env, "PI_SERVER_USERNAME") || "pi";
  const password = envValue(env, "PI_SERVER_PASSWORD") || "";
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  if (doctorToken) headers["x-punch-doctor-token"] = doctorToken;
  return headers;
}

function urlMatchesSandbox(value, sandboxName, port) {
  if (!value || !sandboxName) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === `sandbox-${sandboxName}` && parsed.port === String(port);
  } catch {
    return false;
  }
}

async function routingCheck({ userId, sandboxName, sandbox, apiUrl, gatewayUrl }) {
  const startedAt = Date.now();
  try {
    const users = await withTimeout(() => {
      if (typeof sandbox?.loadUsers !== "function") throw new Error("sandbox.loadUsers is unavailable");
      return sandbox.loadUsers();
    });
    if (!Array.isArray(users)) throw new Error("sandbox.loadUsers did not return an array");

    const mappings = users.filter((entry) => String(entry?.userId) === String(userId));
    if (!userId || !sandboxName || mappings.length === 0) {
      return [check("routing", "fail", "Routing and mapping", "No sandbox mapping is available for this user.", elapsed(startedAt), "Create or repair the user's sandbox mapping.")];
    }

    const names = [...new Set(mappings.map((entry) => entry?.name).filter(Boolean))];
    const problems = [];
    if (mappings.length !== 1) problems.push(`${mappings.length} mappings found`);
    if (names.length !== 1 || names[0] !== sandboxName) problems.push(`mapping does not resolve to ${sandboxName}`);
    if (!urlMatchesSandbox(gatewayUrl, sandboxName, 4096)) problems.push("gateway URL is inconsistent");
    if (!urlMatchesSandbox(apiUrl, sandboxName, 4097)) problems.push("supervisor URL is inconsistent");

    if (problems.length) {
      return [check("routing", "fail", "Routing and mapping", problems.join("; ") + ".", elapsed(startedAt), "Reload the sandbox registry and verify the user's mapping and service URLs.")];
    }
    return [check("routing", "pass", "Routing and mapping", `User maps consistently to sandbox ${sandboxName}.`, elapsed(startedAt))];
  } catch (error) {
    return [check("routing", "fail", "Routing and mapping", `Could not inspect routing: ${errorMessage(error)}`, elapsed(startedAt), "Verify the sandbox registry is readable.")];
  }
}

async function containerCheck({ sandboxName, sandbox }) {
  const startedAt = Date.now();
  try {
    if (!sandboxName) throw new Error("sandbox name is unavailable");
    if (typeof sandbox?.getContainerDiagnostics !== "function") {
      if (typeof sandbox?.isContainerRunning !== "function") throw new Error("container inspection is unavailable");
      const running = await withTimeout(() => sandbox.isContainerRunning(sandboxName), 12_000);
      return [running
        ? check("container", "pass", "Sandbox container", `Sandbox ${sandboxName} is running.`, elapsed(startedAt))
        : check("container", "fail", "Sandbox container", `Sandbox ${sandboxName} is not running.`, elapsed(startedAt), "Restart the sandbox container.")];
    }

    const details = await withTimeout(() => sandbox.getContainerDiagnostics(sandboxName), 12_000);
    const duration = elapsed(startedAt);
    const mountsByDestination = new Map(details.mounts?.map((mount) => [mount.destination, mount]));
    const mountProblems = Object.entries(details.expectedMounts || {}).flatMap(([destination, expectedName]) => {
      const mount = mountsByDestination.get(destination);
      if (!mount) return [`${destination} missing`];
      if (mount.name !== expectedName) return [`${destination} uses ${mount.name || "an anonymous mount"}`];
      if (!mount.rw) return [`${destination} is read-only`];
      return [];
    });
    const hasTun = details.devices?.includes("/dev/net/tun");
    const hasNetAdmin = details.capabilities?.includes("NET_ADMIN");
    const unexpectedCapabilities = (details.capabilities || []).filter((capability) => capability !== "NET_ADMIN");
    const checks = [
      details.running
        ? check("container", "pass", "Sandbox container", `Running (${details.status}${details.health ? `, health ${details.health}` : ""}).`, duration)
        : check("container", "fail", "Sandbox container", `Not running (${details.status}).`, duration, "Restart the sandbox container."),
      details.imageMatches
        ? check("container-image", "pass", "Sandbox image", `Using expected image ${details.expectedImage}.`, duration)
        : check("container-image", "warn", "Sandbox image", `Using ${details.image || "unknown"}; expected ${details.expectedImage}.`, duration, "Recreate the sandbox with the current image."),
      mountProblems.length === 0
        ? check("container-mounts", "pass", "Persistent storage", "Expected writable work, data, home, and Tailscale volumes are attached.", duration)
        : check("container-mounts", "fail", "Persistent storage", `Mount problems: ${mountProblems.join("; ")}.`, duration, "Recreate the sandbox after verifying volume configuration."),
      hasTun && hasNetAdmin
        ? check("container-tailscale", "pass", "Tailscale container access", "TUN device and NET_ADMIN capability are present.", duration)
        : check("container-tailscale", "fail", "Tailscale container access", `Missing ${[!hasTun && "/dev/net/tun", !hasNetAdmin && "NET_ADMIN"].filter(Boolean).join(" and ")}.`, duration, "Recreate the sandbox with Tailscale device access."),
      details.networks?.includes(details.expectedNetwork)
        ? check("container-network", "pass", "Docker network", `Attached to ${details.expectedNetwork}.`, duration)
        : check("container-network", "fail", "Docker network", `Not attached to expected network ${details.expectedNetwork}.`, duration, "Recreate the sandbox on the Nightly edge network."),
    ];
    if (details.oomKilled) checks.push(check("container-oom", "fail", "Container memory", "Last process exit was caused by an OOM kill.", duration, "Inspect workload memory use before restarting."));
    else checks.push(check("container-oom", "pass", "Container memory", "No OOM kill recorded.", duration));
    if (details.restartCount > 3) checks.push(check("container-restarts", "warn", "Container restarts", `${details.restartCount} restarts recorded.`, duration, "Inspect sandbox logs for a crash loop."));
    if (unexpectedCapabilities.length) checks.push(check("container-capabilities", "warn", "Container capabilities", `Unexpected capabilities: ${unexpectedCapabilities.join(", ")}.`, duration, "Remove unneeded container capabilities."));
    return checks;
  } catch (error) {
    return [check("container", "fail", "Sandbox container", `Could not inspect the container: ${errorMessage(error)}`, elapsed(startedAt), "Check Docker access and the sandbox name.")];
  }
}

async function fetchCheck({ id, title, baseUrl, path, fetchImpl, env, doctorToken, timeoutMs = CHECK_TIMEOUT_MS }) {
  const startedAt = Date.now();
  if (!baseUrl) return [check(id, "fail", title, `${title} URL is unavailable.`, elapsed(startedAt), "Repair the user's sandbox routing.")];

  try {
    const target = new URL(path, `${String(baseUrl).replace(/\/$/, "")}/`);
    const response = await withTimeout(() => fetchImpl(target, {
      headers: authHeaders(env, doctorToken),
      signal: AbortSignal.timeout(timeoutMs),
    }), timeoutMs + 250);
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "error"}`);
    return { response, startedAt };
  } catch (error) {
    return [check(id, "fail", title, `${title} request failed: ${errorMessage(error)}`, elapsed(startedAt), "Check the sandbox process, network, and logs.")];
  }
}

async function gatewayCheck(context) {
  const outcome = await fetchCheck({
    ...context,
    id: "gateway",
    title: "Pi gateway health",
    baseUrl: context.gatewayUrl,
    path: "health",
  });
  if (Array.isArray(outcome)) return outcome;
  return [check("gateway", "pass", "Pi gateway health", "Gateway /health responded successfully.", elapsed(outcome.startedAt))];
}

function normalizeSupervisorCheck(value, index, fallbackDuration) {
  if (!value || typeof value !== "object") {
    return check(`supervisor-${index + 1}`, "fail", "Supervisor diagnostic", "Supervisor returned a malformed check.", fallbackDuration);
  }
  return check(
    value.id || `supervisor-${index + 1}`,
    value.status,
    value.title || "Supervisor diagnostic",
    value.message || "No details returned.",
    value.durationMs ?? fallbackDuration,
    value.fix,
  );
}

async function supervisorChecks(context) {
  const path = `doctor?deep=${context.deep ? "true" : "false"}`;
  const outcome = await fetchCheck({
    ...context,
    id: "supervisor",
    title: "Sandbox supervisor doctor",
    baseUrl: context.apiUrl,
    path,
    timeoutMs: context.deep ? 35_000 : 15_000,
  });
  if (Array.isArray(outcome)) return outcome;

  try {
    const body = await withTimeout(() => outcome.response.json());
    const returnedChecks = Array.isArray(body) ? body : body?.checks;
    if (!Array.isArray(returnedChecks)) throw new Error("response did not contain a checks array");
    if (returnedChecks.length === 0) {
      return [check("supervisor", "info", "Sandbox supervisor doctor", "Supervisor returned no checks.", elapsed(outcome.startedAt))];
    }
    return returnedChecks.map((item, index) => normalizeSupervisorCheck(item, index, elapsed(outcome.startedAt)));
  } catch (error) {
    return [check("supervisor", "fail", "Sandbox supervisor doctor", `Invalid supervisor response: ${errorMessage(error)}`, elapsed(outcome.startedAt), "Check the supervisor version and logs.")];
  }
}

function invalidRoutineFields(routine) {
  const invalid = [];
  if (!routine || typeof routine !== "object") return ["record"];
  if (typeof routine.id !== "string" || !routine.id.trim()) invalid.push("id");
  if (typeof routine.userId !== "string" || !routine.userId.trim()) invalid.push("userId");
  if (["message", "llm"].includes(routine.type) && (typeof routine.channelId !== "string" || !routine.channelId.trim())) invalid.push("channelId");
  if (routine.guildId !== null && routine.guildId !== undefined && typeof routine.guildId !== "string") invalid.push("guildId");
  if (!new Set(["message", "llm", "heartbeat", "memory-audit"]).has(routine.type)) invalid.push("type");
  if (typeof routine.payload !== "string") invalid.push("payload");
  if (typeof routine.enabled !== "boolean") invalid.push("enabled");
  if (!Number.isFinite(routine.nextRunAt)) invalid.push("nextRunAt");
  if (routine.lastRunAt !== null && routine.lastRunAt !== undefined && !Number.isFinite(routine.lastRunAt)) invalid.push("lastRunAt");
  if (!Number.isFinite(routine.createdAt)) invalid.push("createdAt");

  const schedule = routine.schedule;
  const validSchedule = schedule && typeof schedule === "object" && (
    (schedule.kind === "once" && Number.isFinite(schedule.at)) ||
    (schedule.kind === "cron" && typeof schedule.cron === "string" && schedule.cron.trim()) ||
    (schedule.kind === "interval" && Number.isFinite(schedule.everyMs) && schedule.everyMs > 0)
  );
  if (!validSchedule) invalid.push("schedule");
  return invalid;
}

async function routineChecks({ routines, userId }) {
  const startedAt = Date.now();
  try {
    if (typeof routines?.listAll !== "function") throw new Error("routines.listAll is unavailable");
    const allRecords = await withTimeout(() => routines.listAll());
    if (!Array.isArray(allRecords)) throw new Error("routines.listAll did not return an array");
    const records = allRecords.filter((routine) => String(routine?.userId) === String(userId));

    const now = Date.now();
    const overdueGraceMs = 2 * 60_000;
    const overdue = records.filter((routine) => routine?.enabled === true && Number.isFinite(routine.nextRunAt) && routine.nextRunAt < now - overdueGraceMs);
    const idCounts = new Map();
    for (const routine of allRecords) {
      if (typeof routine?.id === "string" && routine.id) idCounts.set(routine.id, (idCounts.get(routine.id) || 0) + 1);
    }
    const inspectedIds = new Set(records.map((routine) => routine?.id).filter(Boolean));
    const duplicateIds = [...idCounts].filter(([id, count]) => count > 1 && inspectedIds.has(id)).map(([id]) => id);
    const invalid = records.flatMap((routine, index) => {
      const fields = invalidRoutineFields(routine);
      return fields.length ? [`${routine?.id || `#${index + 1}`} (${fields.join(", ")})`] : [];
    });
    const duration = elapsed(startedAt);

    return [
      overdue.length
        ? check("routines-overdue", "warn", "Overdue routines", `${overdue.length} enabled routine(s) are overdue: ${overdue.slice(0, 5).map((r) => r.id).join(", ")}.`, duration, "Check the routine scheduler and recent delivery errors.")
        : check("routines-overdue", "pass", "Overdue routines", "No enabled routines are overdue.", duration),
      duplicateIds.length
        ? check("routines-duplicates", "fail", "Routine IDs", `Duplicate routine IDs: ${duplicateIds.slice(0, 5).join(", ")}.`, duration, "Remove or regenerate duplicate routine records.")
        : check("routines-duplicates", "pass", "Routine IDs", "Routine IDs are unique.", duration),
      invalid.length
        ? check("routines-invalid", "fail", "Routine fields", `Invalid routine records: ${invalid.slice(0, 5).join("; ")}.`, duration, "Repair or remove malformed routine records.")
        : check("routines-invalid", "pass", "Routine fields", "Routine records have valid core fields.", duration),
    ];
  } catch (error) {
    return [check("routines", "fail", "Routine scheduler", `Could not inspect routines: ${errorMessage(error)}`, elapsed(startedAt), "Verify the routine store is available.")];
  }
}

async function securityCheck({ env }) {
  const startedAt = Date.now();
  try {
    const password = envValue(env, "PI_SERVER_PASSWORD");
    if (typeof password !== "string" || password.trim().length === 0) {
      return [check("security-password", "warn", "Supervisor authentication", "PI_SERVER_PASSWORD is empty.", elapsed(startedAt), "Set a strong PI_SERVER_PASSWORD and recreate affected sandboxes.")];
    }
    return [check("security-password", "pass", "Supervisor authentication", "PI_SERVER_PASSWORD is configured.", elapsed(startedAt))];
  } catch (error) {
    return [check("security-password", "fail", "Supervisor authentication", `Could not inspect security configuration: ${errorMessage(error)}`, elapsed(startedAt))];
  }
}

function memoryChecks({ memory, routines, userId }) {
  if (typeof memory?.getMemoryStatus !== "function") return [];
  const status = memory.getMemoryStatus();
  const checks = [check("memory", status.available ? "pass" : "fail", "Memory store",
    status.available ? "SQLite memory is available." : String(status.error || "Memory is disabled.").slice(0, 700), 0,
    status.available ? undefined : "Restore the named source or SQLite backup, then restart the bot. Memory writes remain disabled until recovery.")];
  if (!status.available || typeof memory.memoryAuditStatus !== "function" || typeof routines?.listAll !== "function") return checks;
  const startedAt = Date.now();
  try {
    const routine = routines.listAll().find((entry) => entry.type === "memory-audit" && String(entry.userId) === String(userId));
    const audit = memory.memoryAuditStatus(userId);
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const last = audit.last ? `last applied ${day(audit.last.at)} (${audit.last.added} added, ${audit.last.merged} merged, ${audit.last.dropped} dropped, ${audit.last.fixed} fixed, ${audit.last.flagged} flagged)` : "no audit changes applied yet";
    const summary = `${audit.facts} fact(s), ${audit.unconfirmed} unconfirmed; ${last}.`;
    const duration = elapsed(startedAt);
    if (!routine) checks.push(check("memory-audit", "warn", "Weekly memory audit", `No audit routine is scheduled. ${summary}`, duration, "Restart the bot to recreate built-in routines."));
    else if (routine.state === "failed") checks.push(check("memory-audit", "warn", "Weekly memory audit", `Audit stopped after failures: ${String(routine.lastError || "unknown error").slice(0, 300)} ${summary}`, duration, `Resume routine ${routine.id} once the sandbox is healthy.`));
    else if (!routine.enabled) checks.push(check("memory-audit", "info", "Weekly memory audit", `Audit routine ${routine.id} is paused. ${summary}`, duration));
    else checks.push(check("memory-audit", "pass", "Weekly memory audit", `Next run ${day(routine.nextRunAt)}; ${summary}`, duration));
  } catch (error) {
    checks.push(check("memory-audit", "warn", "Weekly memory audit", `Could not inspect memory audit: ${errorMessage(error)}`, elapsed(startedAt)));
  }
  return checks;
}

function summarize(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const item of checks) summary[item.status] += 1;
  return summary;
}

export async function runDoctor({ userId, sandboxName, deep = false, sandbox, apiUrl, gatewayUrl, doctorToken, routines, memory, env = process.env } = {}) {
  const startedAt = Date.now();
  const fetchImpl = typeof env?.fetch === "function" ? env.fetch : globalThis.fetch;
  const context = { userId, sandboxName, deep: Boolean(deep), sandbox, apiUrl, gatewayUrl, doctorToken, routines, env, fetchImpl };

  const groups = await Promise.all([
    routingCheck(context),
    memoryChecks({ memory, routines, userId }),
    containerCheck(context),
    gatewayCheck(context),
    supervisorChecks(context),
    routineChecks(context),
    securityCheck(context),
  ]);
  const checks = groups.flat();
  return { checks, summary: summarize(checks), durationMs: elapsed(startedAt) };
}

function safeText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderDoctorReport(result, sandboxName) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const summary = result?.summary || summarize(checks.map((item) => ({ ...item, status: STATUSES.has(item?.status) ? item.status : "info" })));
  const icons = { pass: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };
  const lines = [
    `**Punch Doctor — ${safeText(sandboxName || "unassigned")}**`,
    `${summary.pass || 0} passed · ${summary.warn || 0} warnings · ${summary.fail || 0} failed · ${summary.info || 0} info`,
  ];

  for (const item of checks) {
    const status = STATUSES.has(item?.status) ? item.status : "info";
    lines.push(`${icons[status]} **${safeText(item?.title || item?.id || "Check")}** — ${safeText(item?.message || "No details.")}`);
    if (item?.fix) lines.push(`↳ Fix: ${safeText(item.fix)}`);
  }

  const footer = `\nCompleted in ${Math.max(0, Number(result?.durationMs) || 0)}ms`;
  const bodyLimit = 1900 - footer.length;
  let body = lines.join("\n");
  if (body.length > bodyLimit) body = `${body.slice(0, Math.max(0, bodyLimit - 2)).trimEnd()}…`;
  return body + footer;
}
