import { escapeStrayMarkdown, truncateMarkdown } from "./discord-markdown.js";

const LIVE_CURRENT_LIMIT = 180;
const ACTION_LIMIT = 140;
const FIELD_LIMITS = Object.freeze({ goal: 200, finding: 300, next: 200 });
const MAX_RECAP_ACTIONS = 5;
const MAX_RECAP_MILESTONES = 3;
const MAX_DISCORD_CONTENT = 1900;
const MAX_TODOS = 50;
const TODO_TEXT_LIMIT = 200;
const MAX_VISIBLE_TODOS = 15;
const TODOS_BEFORE_CURRENT = 3;
const MAX_EMBED_DESCRIPTION = 4096;
const PLAN_COLOR = 0x5865f2;

const PHASE_LABELS = Object.freeze({
  starting: "Starting",
  thinking: "Thinking",
  working: "Working",
  tool: "Using tools",
  milestone: "Progress",
  writing: "Writing",
  retrying: "Retrying",
  compacting: "Compacting",
  completed: "Completed",
  error: "Failed",
  aborted: "Stopped",
  timeout: "Timed out",
});

const STATUS_ICONS = Object.freeze({
  running: "⏳",
  completed: "✅",
  error: "⚠️",
  aborted: "🛑",
  timeout: "⏱️",
});

const LEGACY_TOOL_ACTIONS = Object.freeze({
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

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function sanitizeProgressText(value, maxLength = LIVE_CURRENT_LIMIT) {
  let text = String(value || "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[redacted]")
    .replace(/data:[^\s;,]+;base64,[a-z0-9+/=]+/gi, "[redacted]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/<[@#][!&]?\d+>/g, "[mention]")
    .replace(/@(everyone|here)\b/gi, "(at)$1")
    .replace(/@/g, "(at)")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length > maxLength) text = text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
  return text;
}

function safePhase(value, fallback = "working") {
  const phase = String(value || "").toLowerCase();
  return PHASE_LABELS[phase] ? phase : fallback;
}

function safeStatus(value, fallback = "running") {
  const status = String(value || "").toLowerCase();
  return STATUS_ICONS[status] ? status : fallback;
}

function safeMilestone(value) {
  const milestone = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    const text = sanitizeProgressText(value?.[field], limit);
    if (text) milestone[field] = text;
  }
  return milestone;
}

function addMilestone(milestones, value) {
  const milestone = safeMilestone(value);
  if (!Object.keys(milestone).length) return milestones;
  const key = JSON.stringify(milestone);
  if (milestones.some((item) => JSON.stringify(item) === key)) return milestones;
  return [...milestones, milestone].slice(-6);
}

function addAction(actions, value) {
  const action = sanitizeProgressText(value, ACTION_LIMIT);
  if (!action || actions.includes(action)) return actions;
  return [...actions, action].slice(-12);
}

function safeTodos(value) {
  if (!Array.isArray(value)) return null;
  const todos = [];
  for (const todo of value.slice(0, MAX_TODOS)) {
    const text = sanitizeProgressText(todo?.text, TODO_TEXT_LIMIT);
    if (text) todos.push({ text, done: todo?.done === true });
  }
  return todos;
}

export function createProgressState(startedAt = Date.now()) {
  return {
    startedAt,
    elapsedMs: 0,
    thinkingMs: 0,
    toolCalls: 0,
    phase: "starting",
    status: "running",
    current: "Working",
    goal: "",
    finding: "",
    next: "",
    actions: [],
    milestones: [],
    todos: [],
    legacyToolIds: [],
    source: "none",
  };
}

function reduceGatewayProgress(state, properties) {
  const milestone = safeMilestone(properties);
  const current = sanitizeProgressText(properties.current, LIVE_CURRENT_LIMIT);
  const status = safeStatus(properties.status, state.status);
  const phase = safePhase(properties.phase, status === "running" ? state.phase : status);
  const next = {
    ...state,
    source: "gateway",
    status,
    phase,
    current: current || state.current,
    elapsedMs: Math.max(state.elapsedMs, number(properties.elapsedMs)),
    thinkingMs: Math.max(state.thinkingMs, number(properties.thinkingMs)),
    toolCalls: Math.max(state.toolCalls, Math.floor(number(properties.toolCalls))),
    milestones: addMilestone(state.milestones, milestone),
    todos: safeTodos(properties.todos) ?? state.todos,
  };
  for (const field of Object.keys(FIELD_LIMITS)) {
    if (milestone[field]) next[field] = milestone[field];
  }
  if (phase === "tool" && current) next.actions = addAction(state.actions, current);
  return next;
}

function legacyToolAction(part) {
  const title = sanitizeProgressText(part?.state?.title, ACTION_LIMIT);
  if (title) return title;
  const name = String(part?.tool || "").toLowerCase();
  const base = LEGACY_TOOL_ACTIONS[name] || "Using a tool";
  const input = part?.state?.input || part?.state?.arguments;
  if (!input || typeof input !== "object") return base;
  if (["read", "write", "edit"].includes(name)) {
    const p = sanitizeProgressText(input.path || input.filePath, 80);
    if (p) return `${base} ${p}`;
  }
  if (name === "bash") {
    const cmd = sanitizeProgressText(input.command, 80);
    if (cmd) return `Running ${cmd}`;
  }
  if (["grep", "find", "glob"].includes(name)) {
    const p = sanitizeProgressText(input.path || input.pattern, 80);
    if (p) return `${base} ${p}`;
  }
  if (["webfetch", "puppeteer_navigate"].includes(name)) {
    const u = sanitizeProgressText(input.url, 80);
    if (u) return `${base} ${u}`;
  }
  return base;
}

function reduceLegacyProgress(state, event, now) {
  const properties = event?.properties || {};
  if (event?.type === "message.part.delta") {
    return { ...state, source: "legacy", phase: "writing", current: "Writing the response" };
  }
  if (event?.type !== "message.part.updated") return state;
  const part = properties.part || {};
  if (part.type === "text") {
    return { ...state, source: "legacy", phase: "writing", current: "Writing the response" };
  }
  if (part.type !== "tool") return state;

  const action = legacyToolAction(part);
  const id = sanitizeProgressText(part.id || part.callID, 100);
  const isRunning = part.state?.status === "running";
  const isNew = isRunning && (!id || !state.legacyToolIds.includes(id));
  return {
    ...state,
    source: "legacy",
    phase: isRunning ? "tool" : "working",
    current: isRunning ? action : `${action} finished`,
    elapsedMs: Math.max(state.elapsedMs, now - state.startedAt),
    toolCalls: state.toolCalls + (isNew ? 1 : 0),
    actions: isNew ? addAction(state.actions, action) : state.actions,
    legacyToolIds: id && isNew ? [...state.legacyToolIds, id].slice(-100) : state.legacyToolIds,
  };
}

export function reduceProgressEvent(state, event, now = Date.now()) {
  if (event?.type === "session.progress") {
    return reduceGatewayProgress(state, event.properties || {});
  }
  if (state.source === "gateway") return state;
  return reduceLegacyProgress(state, event, now);
}

export function applyProgressActivity(state, activity) {
  if (!activity || typeof activity !== "object") return state;
  const status = safeStatus(activity.status, state.status);
  const current = sanitizeProgressText(activity.current, LIVE_CURRENT_LIMIT);
  const actions = Array.isArray(activity.actions)
    ? activity.actions.reduce((list, action) => addAction(list, action), [])
    : state.actions;
  const milestones = Array.isArray(activity.milestones)
    ? activity.milestones.reduce((list, milestone) => addMilestone(list, milestone), [])
    : state.milestones;
  const latest = milestones[milestones.length - 1] || {};
  return {
    ...state,
    source: "gateway",
    status,
    phase: status === "running" ? state.phase : safePhase(status, state.phase),
    current: current || state.current,
    elapsedMs: number(activity.durationMs, state.elapsedMs),
    thinkingMs: number(activity.thinkingMs, state.thinkingMs),
    toolCalls: Math.floor(number(activity.toolCalls, state.toolCalls)),
    actions,
    milestones,
    todos: safeTodos(activity.todos) ?? state.todos,
    goal: latest.goal || state.goal,
    finding: latest.finding || state.finding,
    next: latest.next || state.next,
  };
}

export function finishProgressState(state, status, now = Date.now()) {
  const safe = safeStatus(status, "error");
  const current = {
    completed: "Complete",
    error: "Request failed",
    aborted: "Request stopped",
    timeout: "Request timed out",
  }[safe];
  return {
    ...state,
    status: safe,
    phase: safe,
    current: current || state.current,
    elapsedMs: Math.max(state.elapsedMs, now - state.startedAt),
  };
}

function elapsedMsFor(state, now) {
  return state.status === "running"
    ? Math.max(state.elapsedMs, now - state.startedAt)
    : state.elapsedMs;
}

export function formatProgressDuration(value) {
  const ms = number(value);
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function renderProgressLive(state, now = Date.now()) {
  const icon = STATUS_ICONS[state.status] || STATUS_ICONS.running;
  const current = escapeStrayMarkdown(sanitizeProgressText(state.current, LIVE_CURRENT_LIMIT)) || "Working on the request";
  const lines = [
    `${icon} ${current} · ${formatProgressDuration(elapsedMsFor(state, now))} · ${state.toolCalls} tool${state.toolCalls === 1 ? "" : "s"}`,
  ];
  if (state.goal) lines.push(`**Goal:** ${escapeStrayMarkdown(sanitizeProgressText(state.goal, FIELD_LIMITS.goal))}`);
  if (state.finding) lines.push(`**Finding:** ${escapeStrayMarkdown(sanitizeProgressText(state.finding, FIELD_LIMITS.finding))}`);
  if (state.next) lines.push(`**Next:** ${escapeStrayMarkdown(sanitizeProgressText(state.next, FIELD_LIMITS.next))}`);
  return lines.join("\n").slice(0, MAX_DISCORD_CONTENT);
}

function todoWindow(todos) {
  const current = todos.findIndex((todo) => !todo.done);
  const anchor = current === -1 ? todos.length : current;
  const start = Math.max(0, Math.min(anchor - TODOS_BEFORE_CURRENT, todos.length - MAX_VISIBLE_TODOS));
  return { current, start, end: Math.min(todos.length, start + MAX_VISIBLE_TODOS) };
}

function todoDescription(todos) {
  const { current, start, end } = todoWindow(todos);
  const lines = todos.slice(start, end).map((todo, offset) => {
    const icon = todo.done ? "✅" : start + offset === current ? "▶️" : "⬜";
    return `${icon} ${escapeStrayMarkdown(sanitizeProgressText(todo.text, TODO_TEXT_LIMIT))}`;
  });
  const describe = (visible) => {
    const hidden = todos.length - start - visible.length;
    return [
      ...(start ? [`*${start} earlier task${start === 1 ? "" : "s"} done*`] : []),
      ...visible,
      ...(hidden ? [`*${hidden} more task${hidden === 1 ? "" : "s"}*`] : []),
    ].join("\n");
  };
  let description = describe(lines);
  while (description.length > MAX_EMBED_DESCRIPTION && lines.length > 1) {
    lines.pop();
    description = describe(lines);
  }
  return description.slice(0, MAX_EMBED_DESCRIPTION);
}

function todoCounts(todos) {
  return { done: todos.filter((todo) => todo.done).length, total: todos.length };
}

export function renderProgressEmbed(state) {
  const todos = state.todos || [];
  if (!todos.length) return null;
  const { done, total } = todoCounts(todos);
  return {
    title: `📋 Plan · ${done}/${total} done`,
    description: todoDescription(todos),
    color: PLAN_COLOR,
  };
}

function progressEmbeds(state) {
  const embed = renderProgressEmbed(state);
  return embed ? [embed] : [];
}

function recapEmbeds(state, replyEmbeds) {
  const embeds = Array.isArray(replyEmbeds) ? replyEmbeds : [];
  if (state.status === "completed" || embeds.length) return embeds;
  return progressEmbeds(state);
}

function appendWithin(lines, line) {
  const candidate = [...lines, line].join("\n");
  if (candidate.length <= MAX_DISCORD_CONTENT) lines.push(line);
}

export function renderProgressRecap(state, result = "") {
  const status = safeStatus(state.status, "error");
  const stats = [
    `🔨 ${state.toolCalls} tool${state.toolCalls === 1 ? "" : "s"} used`,
    `💭 ${formatProgressDuration(state.elapsedMs)}`,
  ];
  if (state.todos?.length) {
    const { done, total } = todoCounts(state.todos);
    stats.push(`📋 ${done}/${total} tasks done`);
  }
  const resultText = String(result || "").trim();

  if (status === "completed") {
    return [`-# ${stats.join(" · ")}`, resultText || "-# no response"].join("\n\n");
  }

  const icon = STATUS_ICONS[status];
  const label = PHASE_LABELS[status] || PHASE_LABELS.error;
  const lines = [`${icon} **${label}** · ${stats.join(" · ")}`];
  if (resultText) appendWithin(lines, resultText);

  const actions = state.actions.slice(0, MAX_RECAP_ACTIONS);
  if (actions.length) {
    appendWithin(lines, "**Actions**");
    for (const action of actions) appendWithin(lines, `- ${escapeStrayMarkdown(sanitizeProgressText(action, ACTION_LIMIT))}`);
  }

  const milestones = state.milestones.slice(0, MAX_RECAP_MILESTONES);
  if (milestones.length) {
    appendWithin(lines, "**Milestones**");
    for (const milestone of milestones) {
      for (const field of Object.keys(FIELD_LIMITS)) {
        if (milestone[field]) {
          const labelText = field[0].toUpperCase() + field.slice(1);
          appendWithin(lines, `- **${labelText}:** ${escapeStrayMarkdown(sanitizeProgressText(milestone[field], 160))}`);
        }
      }
    }
  }
  return lines.join("\n");
}

export function createProgressRenderer({
  initialState,
  edit,
  finalSuffix = "",
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  semanticIntervalMs = 5_000,
  elapsedIntervalMs = 12_000,
}) {
  let state = initialState || createProgressState(now());
  let revision = 0;
  let renderedRevision = 0;
  let lastEditAt = now();
  let timer = null;
  let inFlight = false;
  let finalRequest = null;
  let finalPromise = null;
  let closed = false;

  const clearScheduled = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    clearScheduled();
    if (closed || inFlight || finalRequest) return;
    const time = now();
    const semanticDue = revision > renderedRevision
      ? Math.max(0, lastEditAt + semanticIntervalMs - time)
      : Infinity;
    const elapsedDue = Math.max(0, lastEditAt + elapsedIntervalMs - time);
    timer = setTimer(pump, Math.min(semanticDue, elapsedDue));
  };

  const performEdit = (options) => Promise.resolve(
    edit({ ...options, allowedMentions: { parse: [] } }),
  ).catch(() => {});

  const pump = () => {
    clearScheduled();
    if (closed || inFlight) return;
    if (finalRequest) {
      const request = finalRequest;
      finalRequest = null;
      inFlight = true;
      void performEdit(request.options).finally(() => {
        inFlight = false;
        closed = true;
        request.resolve();
      });
      return;
    }

    const time = now();
    const semanticReady = revision > renderedRevision && time - lastEditAt >= semanticIntervalMs;
    const elapsedReady = time - lastEditAt >= elapsedIntervalMs;
    if (!semanticReady && !elapsedReady) {
      schedule();
      return;
    }

    const editRevision = revision;
    inFlight = true;
    void performEdit({ content: renderProgressLive(state, time), embeds: progressEmbeds(state) }).finally(() => {
      inFlight = false;
      lastEditAt = now();
      renderedRevision = Math.max(renderedRevision, editRevision);
      if (finalRequest) pump();
      else schedule();
    });
  };

  return {
    update(event) {
      if (closed || finalRequest) return state;
      const next = reduceProgressEvent(state, event, now());
      if (next !== state) {
        state = next;
        revision += 1;
        schedule();
      }
      return state;
    },
    finalize(activity = null, fallbackStatus = "completed", result = "", options = {}) {
      if (finalPromise) return finalPromise;
      state = applyProgressActivity(state, activity);
      if (state.status === "running" || fallbackStatus !== "completed") {
        state = finishProgressState(state, fallbackStatus, now());
      }
      revision += 1;
      clearScheduled();
      finalPromise = new Promise((resolve) => {
        const recap = renderProgressRecap(state, result);
        const suffix = String(finalSuffix || "");
        const recapLimit = Math.max(0, MAX_DISCORD_CONTENT - suffix.length);
        const primary = recapLimit ? truncateMarkdown(recap, recapLimit) : "";
        const content = primary.trimEnd() + suffix;
        const embeds = recapEmbeds(state, options.embeds);
        finalRequest = { options: { ...options, content, embeds }, resolve };
        pump();
      });
      return finalPromise;
    },
    discard() {
      if (closed || finalRequest) return;
      clearScheduled();
      closed = true;
    },
    getState() {
      return state;
    },
  };
}

export { MAX_RECAP_ACTIONS, MAX_RECAP_MILESTONES };
