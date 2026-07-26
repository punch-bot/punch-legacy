import { isAbsolute, relative, resolve, sep } from "node:path";

const REPORT_PROGRESS_TOOL = "report_progress";
const WORKSPACE = resolve(process.env.OPENCODE_REMOTE_DIR || "/work");
const MAX_ACTIONS = 12;
const MAX_MILESTONES = 6;
const MAX_ACTION_LENGTH = 140;
const HEARTBEAT_MS = 15_000;
const PUBLIC_FIELD_LIMITS = Object.freeze({
  goal: 200,
  finding: 300,
  next: 200,
});

const TOOL_ACTIONS = Object.freeze({
  bash: "Running a command",
  read: "Reading a file",
  write: "Writing a file",
  edit: "Editing a file",
  grep: "Searching file contents",
  find: "Finding files",
  glob: "Finding files",
  webfetch: "Fetching a web page",
  puppeteer_navigate: "Opening a web page",
  puppeteer_screenshot: "Taking a screenshot",
  puppeteer_click: "Interacting with a web page",
  puppeteer_fill: "Filling a web form",
  puppeteer_select: "Selecting a web option",
  puppeteer_hover: "Inspecting a web page",
  puppeteer_evaluate: "Inspecting a web page",
});

const SECRET_ASSIGNMENT =
  /\b(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SECRET_VALUE_PATTERNS = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][a-z0-9_-]{8,}\b/gi,
  /\bgithub_pat_[a-z0-9_]{20,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[a-z0-9_-]{20,}\.[a-z0-9_-]{6,}\.[a-z0-9_-]{20,}\b/gi,
];

function eventType(event) {
  if (event?.type === "message_update") {
    return event.assistantMessageEvent?.type || "message_update";
  }
  return event?.type || "";
}

function toolName(event) {
  return String(event?.toolName || event?.name || "").toLowerCase();
}

function toolArgs(event) {
  const args = event?.args || event?.arguments;
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function toolCallKey(event, state) {
  const id = event?.toolCallId || event?.toolCallID || event?.callId;
  return id ? `id:${id}` : `anonymous:${state.anonymousToolCalls + 1}`;
}

function redactPublicText(value) {
  let text = String(value || "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[redacted private key]")
    .replace(/data:[^\s;,]+;base64,[a-z0-9+/=]+/gi, "[redacted image data]")
    .replace(/([?&](?:token|secret|key|api[_-]?key|password)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  return text;
}

function neutralizePublicText(value, maxLength) {
  const text = redactPublicText(value)
    .replace(/<[@#][!&]?\d+>/g, "[mention]")
    .replace(/@(everyone|here)\b/gi, "(at)$1")
    .replace(/@/g, "(at)")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/([\\`*_{}\[\]()<>#+.!|>~-])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= maxLength
    ? text
    : text.slice(0, maxLength - 3).trimEnd().replace(/\\+$/, "") + "...";
}

function workspaceRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const absolute = resolve(WORKSPACE, value.trim());
  const rel = relative(WORKSPACE, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (!rel) return "workspace";
  const display = redactPublicText(rel.split(sep).join("/"))
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, 100);
  return display && !display.includes("[redacted") ? display : null;
}

function safeBashCommand(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return null;
  const command = value.trim().replace(/\s+/g, " ");
  if (!command || /[\n\r;&|<>$`'"\\(){}]/.test(command)) return null;

  if (/^npm test(?: --(?: [a-z0-9_./:=,+@~-]+)*)?$/i.test(command)) return "npm test";
  const npmRun = command.match(
    /^npm run ([a-z0-9][a-z0-9:._-]{0,63})(?: --(?: [a-z0-9_./:=,+@~-]+)*)?$/i,
  );
  if (npmRun && /^(?:test|lint|check|typecheck|format|build|verify)(?::[a-z0-9._-]+)?$/i.test(npmRun[1])) {
    return `npm run ${npmRun[1]}`;
  }
  const git = command.match(/^git (status|diff|log)(?: [a-z0-9_./:=,+@~-]+)*$/i);
  if (git) return `git ${git[1].toLowerCase()}`;
  if (/^node --test(?: [a-z0-9_./:=,+@~-]+)*$/i.test(command)) return "node --test";
  return null;
}

function safeHostname(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host.length > 100 || !/^[a-z0-9.:[\]-]+$/.test(host)) return null;
    const display = redactPublicText(host);
    return display && !display.includes("[redacted") ? display : null;
  } catch {
    return null;
  }
}

export function sanitizePublicIntent(args) {
  const intent = {};
  for (const [field, maxLength] of Object.entries(PUBLIC_FIELD_LIMITS)) {
    const value = neutralizePublicText(args?.[field], maxLength);
    if (value) intent[field] = value;
  }
  return intent;
}

export function isReportProgressTool(event) {
  return toolName(event) === REPORT_PROGRESS_TOOL;
}

export function sanitizedToolName(event) {
  const name = toolName(event);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) return "tool";
  return name;
}

export function sanitizedToolAction(event) {
  const name = toolName(event);
  const args = toolArgs(event);
  let action = TOOL_ACTIONS[name] || "Using a tool";

  if (["read", "write", "edit"].includes(name)) {
    const path = workspaceRelativePath(args.path ?? args.filePath ?? args.file_path);
    if (path) action = `${TOOL_ACTIONS[name]} ${path}`;
  } else if (name === "bash") {
    const command = safeBashCommand(args.command);
    if (command) action = `Running ${command}`;
  } else if (["webfetch", "puppeteer_navigate"].includes(name)) {
    const host = safeHostname(args.url);
    if (host) action = `${name === "webfetch" ? "Fetching" : "Opening"} ${host}`;
  } else if (["grep", "find", "glob"].includes(name)) {
    const path = workspaceRelativePath(args.path || ".");
    if (path) action = `${TOOL_ACTIONS[name]} in ${path}`;
  }

  return neutralizePublicText(action, MAX_ACTION_LENGTH) || TOOL_ACTIONS[name] || "Using a tool";
}

export function safeToolSsePart(event, callID, status) {
  const title = sanitizedToolAction(event);
  return {
    type: "tool",
    id: callID,
    callID,
    tool: sanitizedToolName(event),
    // `description` feeds the existing Discord progress formatter without
    // forwarding any original argument or tool result fields.
    state: { status, title, input: { description: title } },
  };
}

export function createProgressState(startedAt) {
  return {
    startedAt,
    closedAt: null,
    status: "running",
    phase: "starting",
    current: "Starting work",
    thinkingStartedAt: null,
    thinkingMs: 0,
    lastHeartbeatAt: startedAt,
    toolCalls: 0,
    anonymousToolCalls: 0,
    seenToolCalls: new Set(),
    toolActions: new Map(),
    reportProgressCallIds: new Set(),
    actions: [],
    seenActions: new Set(),
    milestones: [],
    seenMilestones: new Set(),
  };
}

function withThinkingClosed(state, now) {
  if (state.thinkingStartedAt == null) return state;
  return {
    ...state,
    thinkingMs: state.thinkingMs + Math.max(0, now - state.thinkingStartedAt),
    thinkingStartedAt: null,
  };
}

function snapshot(state, now, extra = {}) {
  const end = state.closedAt ?? now;
  const activeThinking =
    state.thinkingStartedAt == null
      ? 0
      : Math.max(0, end - state.thinkingStartedAt);
  return {
    phase: state.phase,
    status: state.status,
    current: state.current,
    elapsedMs: Math.max(0, end - state.startedAt),
    thinkingMs: state.thinkingMs + activeThinking,
    toolCalls: state.toolCalls,
    ...extra,
  };
}

export function progressSnapshot(state, now) {
  return snapshot(state, now);
}

export function reduceProgress(state, event, now) {
  const type = eventType(event);

  if (
    state.closedAt == null &&
    ["thinking_delta", "tool_execution_update"].includes(type) &&
    now - state.lastHeartbeatAt >= HEARTBEAT_MS
  ) {
    const next = { ...state, lastHeartbeatAt: now };
    return { state: next, progress: [snapshot(next, now, { heartbeat: true })] };
  }

  if (type === "thinking_start") {
    if (state.closedAt != null || state.thinkingStartedAt != null) {
      return { state, progress: [] };
    }
    const next = {
      ...state,
      phase: "thinking",
      current: "Thinking",
      thinkingStartedAt: now,
    };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (type === "thinking_end") {
    if (state.closedAt != null || state.thinkingStartedAt == null) {
      return { state, progress: [] };
    }
    const next = {
      ...withThinkingClosed(state, now),
      phase: "working",
      current: "Choosing the next step",
    };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (type === "agent_start" && state.closedAt == null) {
    const next = { ...state, phase: "working", current: "Working on the request" };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (event?.type === "tool_execution_start" && state.closedAt == null) {
    if (isReportProgressTool(event)) {
      const intent = sanitizePublicIntent(toolArgs(event));
      if (!Object.keys(intent).length) return { state, progress: [] };
      const milestoneKey = JSON.stringify(intent);
      const reportProgressCallIds = new Set(state.reportProgressCallIds);
      const callId = event?.toolCallId || event?.toolCallID || event?.callId;
      if (callId) reportProgressCallIds.add(callId);
      const seenMilestones = new Set(state.seenMilestones);
      const milestones = [...state.milestones];
      if (seenMilestones.has(milestoneKey) || milestones.length >= MAX_MILESTONES) {
        return { state: { ...state, reportProgressCallIds }, progress: [] };
      }
      seenMilestones.add(milestoneKey);
      milestones.push(intent);
      const next = {
        ...state,
        phase: "milestone",
        current: intent.next || intent.finding || intent.goal || "Progress update",
        milestones,
        seenMilestones,
        reportProgressCallIds,
      };
      return { state: next, progress: [snapshot(next, now, intent)] };
    }

    const key = toolCallKey(event, state);
    const seenToolCalls = new Set(state.seenToolCalls);
    const toolActions = new Map(state.toolActions);
    const seenActions = new Set(state.seenActions);
    const actions = [...state.actions];
    const isNew = !seenToolCalls.has(key);
    seenToolCalls.add(key);
    const action = sanitizedToolAction(event);
    toolActions.set(key, action);
    if (isNew && !seenActions.has(action) && actions.length < MAX_ACTIONS) {
      seenActions.add(action);
      actions.push(action);
    }
    const next = {
      ...state,
      phase: "tool",
      current: action,
      seenToolCalls,
      toolActions,
      actions,
      seenActions,
      toolCalls: state.toolCalls + (isNew ? 1 : 0),
      anonymousToolCalls:
        state.anonymousToolCalls + (key.startsWith("anonymous:") ? 1 : 0),
    };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (event?.type === "tool_execution_end" && state.closedAt == null) {
    const id = event?.toolCallId || event?.toolCallID || event?.callId;
    if (isReportProgressTool(event) || (id && state.reportProgressCallIds.has(id))) {
      return { state, progress: [] };
    }
    const action = id ? state.toolActions.get(`id:${id}`) : null;
    const next = {
      ...state,
      phase: "working",
      current: event.isError
        ? `${action || "Tool action"} failed`
        : `${action || "Tool action"} finished`,
    };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (type === "text_start" || type === "text_delta") {
    if (state.closedAt != null) {
      return { state, progress: [] };
    }
    if (state.phase === "writing") {
      if (now - state.lastHeartbeatAt < HEARTBEAT_MS) return { state, progress: [] };
      const next = { ...state, lastHeartbeatAt: now };
      return { state: next, progress: [snapshot(next, now, { heartbeat: true })] };
    }
    const next = { ...state, phase: "writing", current: "Writing the response" };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (["auto_retry_start", "retry_start"].includes(type) && state.closedAt == null) {
    const next = { ...state, phase: "retrying", current: "Retrying the model request" };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (
    ["auto_compaction_start", "compaction_start", "compact_start"].includes(type) &&
    state.closedAt == null
  ) {
    const next = { ...state, phase: "compacting", current: "Compacting session context" };
    return { state: next, progress: [snapshot(next, now)] };
  }

  if (event?.type === "agent_settled") {
    return closeProgress(state, "completed", now);
  }

  if (
    ["agent_aborted", "aborted", "abort"].includes(type) ||
    (type === "error" && event?.assistantMessageEvent?.reason === "aborted")
  ) {
    return closeProgress(state, "aborted", now);
  }

  if (["agent_error", "error"].includes(type)) {
    if (state.closedAt != null) return { state, progress: [] };
    const next = {
      ...withThinkingClosed(state, now),
      phase: "working",
      current: "Recovering from a model error",
    };
    return { state: next, progress: [snapshot(next, now)] };
  }

  return { state, progress: [] };
}

export function closeProgress(state, status, now) {
  if (state.closedAt != null) {
    if (state.status === status || state.status !== "completed") {
      return { state, progress: [] };
    }
    const revised = {
      ...state,
      status,
      phase: status,
      current: status === "aborted" ? "Request stopped" : "Request failed",
    };
    return { state: revised, progress: [snapshot(revised, now)] };
  }

  const closed = withThinkingClosed(state, now);
  const next = {
    ...closed,
    closedAt: now,
    status,
    phase: status,
    current:
      status === "completed"
        ? "Complete"
        : status === "aborted"
          ? "Request stopped"
          : "Request failed",
  };
  return { state: next, progress: [snapshot(next, now)] };
}

export function activityFromProgress(state, now) {
  const data = snapshot(state, now);
  return {
    status: data.status,
    durationMs: data.elapsedMs,
    thinkingMs: data.thinkingMs,
    toolCalls: data.toolCalls,
    current: data.current,
    actions: [...state.actions],
    milestones: state.milestones.map((milestone) => ({ ...milestone })),
  };
}

export { HEARTBEAT_MS, MAX_ACTIONS, MAX_MILESTONES, PUBLIC_FIELD_LIMITS };
