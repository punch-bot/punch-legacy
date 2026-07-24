# Plan: Heartbeat Scheduler + Persistent State Store

## Goal

Make Punch autonomous by adding a heartbeat scheduler (periodic LLM turns that fire on a schedule and DM the user) and a persistent state store to track all agent activity across restarts. The LLM can also **self-serve** — creating, listing, pausing, resuming, and removing its own heartbeats via the existing routines tool.

## Architecture

```
Reactive:   Discord mention → bot → sandbox → reply in channel (existing)
Autonomous: Heartbeat timer → bot → sandbox → DM user (new)
Self-serve: LLM in sandbox → routines tool → bot API → heartbeat created (new)
```

All three paths share the same sandbox. Autonomous/heartbeat turns use a **per-user session** so context persists across fires. Reactive turns use per-channel sessions (existing behavior).

### Self-serve flow

```
User: "check on my deploy every 6 hours and ping me if anything's wrong"
LLM:  [calls routines tool: create heartbeat "every 6h" "check deploy status"]
      → POST bot:4098/routines/create { type: "heartbeat", ... }
      → bot creates routine in /state/routines.json
      → "Done — I'll check every 6 hours and DM you if there's an issue."
6h later: heartbeat fires → sandbox runs → user gets DM
```

## Files to Create

### 1. `src/state.js` — Persistent state store

Replaces the in-memory-only `activityLogs` map in `opencode.js` with a persistent store.

**Data structure:**
```js
{
  activities: [
    {
      id: string,          // base36 timestamp+seq
      ts: number,          // epoch ms
      userId: string,      // Discord user ID
      channelId: string|null, // null for autonomous/heartbeat
      type: string,        // "reactive" | "heartbeat" | "pigeon"
      prompt: string,      // input (truncated to 500 chars)
      response: string,    // output (truncated to 2000 chars)
      sessionId: string,   // opencode session ID
      status: string,      // "success" | "error" | "timeout"
      duration: number,    // ms
      routineId: string|null,
    }
  ],
  heartbeatSessions: {
    [userId]: string  // dedicated session ID for autonomous turns
  }
}
```

**File:** `/state/state.json` (bot_state volume)

**Exports:**
- `recordActivity(entry)` — append + persist
- `getActivities(userId, opts?)` — query with limit/type filters
- `getHeartbeatSession(userId)` / `setHeartbeatSession(userId, sessionId)`
- `getActivityStats(userId)` — counts by type, last activity time

**Pattern:** Same load-on-start/save-on-mutate as `memory.js` and `routines.js`. Hold in memory, flush on every mutation.

### 2. `src/heartbeat.js` — Heartbeat scheduler

A standalone module that ticks every 60s and fires due heartbeat routines.

**Exports:**
- `startHeartbeat(fireCallback)` — start the tick loop
- `stopHeartbeat()` — stop

**Tick logic:**
1. Load all routines where `type === "heartbeat"` and `enabled === true` and `nextRunAt <= now`
2. For each, call `fireCallback(routine)` (which DMs the user)
3. Call `routines.markFired(routine)` to advance the schedule
4. Sleep until the next due routine

**Config:** `HEARTBEAT_INTERVAL_MS` env var (default 60000 = 60s). The tick interval is separate from the routine schedule — a heartbeat routine might fire every 6h, but the tick checks every 60s to see if anything is due.

## Files to Modify

### 3. `src/routines.js` — Add `heartbeat` type

- `parseRecurrence()`: already handles `once`, `daily`, `weekly`, `every Nm/Nh`, raw cron — no changes needed, heartbeats use the same schedule types
- `addRoutine()`: accepts `type: "heartbeat"` — no validation change needed since it already accepts any string for `type`
- `formatRoutine()`: add heartbeat label (e.g. `[heartbeat]` instead of `[auto]` or `[remind]`)

### 4. `src/index.js` — Three changes

**A. `fireRoutine` — add `heartbeat` case (after the `llm` case, ~line 2009):**

```js
if (routine.type === "heartbeat") {
  // Ensure sandbox is reachable
  const sandboxUrl = await ensureUserSandbox(routine.userId);
  if (!sandboxUrl) {
    // DM the user that their sandbox is down
    const dm = await client.users.createDM(routine.userId);
    await dm.send(`⚠️ Heartbeat failed — sandbox unreachable.`);
    return;
  }

  const uid = routine.userId;
  // Use dedicated heartbeat session (persists across fires)
  const existingSession = state.getHeartbeatSession(uid);
  const prompt = `[user:${uid}] (heartbeat): ${routine.payload}`;
  const start = Date.now();

  try {
    const res = await runOpencode(prompt, existingSession, null, null, uid);
    state.setHeartbeatSession(uid, res.sessionId);

    // Process output (same as llm routine)
    const { clean, saved, dropped } = persistMemoryTags(res.text, uid, null);
    // ... extract attachments, embeds, questions (same pattern as llm)

    // DM the user
    const dm = await client.users.createDM(routine.userId);
    const header = `💓 **Heartbeat** —\n`;
    // ... send chunks to DM

    state.recordActivity({
      userId: uid, channelId: null, type: "heartbeat",
      prompt: routine.payload.slice(0, 500),
      response: (clean || "").slice(0, 2000),
      sessionId: res.sessionId, status: "success",
      duration: Date.now() - start, routineId: routine.id,
    });
  } catch (err) {
    const dm = await client.users.createDM(routine.userId);
    await dm.send(`⚠️ Heartbeat error: ${err.message}`);
    state.recordActivity({
      userId: uid, channelId: null, type: "heartbeat",
      prompt: routine.payload.slice(0, 500),
      response: err.message.slice(0, 2000),
      sessionId: existingSession || null, status: "error",
      duration: Date.now() - start, routineId: routine.id,
    });
  }
  return;
}
```

**B. Also record activity for existing `llm` and `message` routines:**

Wrap the existing `llm` routine code in a try/finally that calls `state.recordActivity(...)` at the end.

**C. Startup — start the heartbeat scheduler:**

After `routines.startScheduler(fireRoutine)` (line 995), add:
```js
heartbeat.startHeartbeat(fireRoutine);
```

**D. Record activity for reactive turns:**

In `handleChat` / `enqueueChat`, after a turn completes, call `state.recordActivity(...)` with `type: "reactive"`.

### 5. `src/index.js` — Slash command: `/heartbeat`

Add to the `slashCmd` array:

```js
{
  name: "heartbeat",
  description: "Schedule autonomous heartbeat automations (run in your sandbox, DM you results)",
  options: [
    { type: 1, name: "add", description: "Add a heartbeat automation",
      options: [
        { type: 3, name: "when", description: "Schedule (e.g. every 6h, daily 9am, every 30m)", required: true },
        { type: 3, name: "prompt", description: "What the agent should do each time", required: true },
      ] },
    { type: 1, name: "list", description: "List your heartbeat automations" },
    { type: 1, name: "remove", description: "Remove a heartbeat",
      options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
    { type: 1, name: "pause", description: "Pause a heartbeat",
      options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
    { type: 1, name: "resume", description: "Resume a heartbeat",
      options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
    { type: 1, name: "history", description: "View recent autonomous activity" },
  ],
},
```

**Interaction handler:** Add cases in the `InteractionCreate` handler for the `heartbeat` command.

### 6. `src/opencode.js` — Bridge activity logging

- Keep the existing in-memory `activityLogs` map for the `/logs` slash command (fast access)
- Also call `state.recordActivity(...)` from the relevant code paths
- Remove the hard cap of 150 lines — the persistent store handles retention

### 7. `docker/routines_tool.ts` — Extend for self-serve heartbeats

The LLM already has a `routines` tool that calls `POST /routines/create`. Extend it to support:

**New action: `create` with `type: "heartbeat"`**
- The tool already accepts `type` as a parameter — just add `"heartbeat"` as a valid choice
- The LLM can now say: `[create heartbeat "every 6h" "check disk usage"]`
- Bot receives the request, creates a routine with `type: "heartbeat"` via `routines.addRoutine()`

**New actions: `pause` and `resume`**
- Add `pause` and `resume` to the tool's action enum
- These call `POST /routines/:id/pause` and `POST /routines/:id/resume` on the bot API
- The LLM can manage its own heartbeats without user intervention

**Updated tool schema:**
```ts
args: {
  action: tool.schema.enum(["create", "list", "remove", "pause", "resume"]),
  userId: tool.schema.string(),
  channelId: tool.schema.string().optional(),
  type: tool.schema.enum(["message", "llm", "heartbeat"]).optional(),
  when: tool.schema.string().optional(),
  text: tool.schema.string().optional(),
  recurrence: tool.schema.string().optional(),
  id: tool.schema.string().optional(),  // for remove/pause/resume
}
```

**New HTTP endpoints on bot `:4098`** (to support pause/resume):
```
POST /routines/:id/pause   — { userId } — pause a routine
POST /routines/:id/resume  — { userId } — resume a routine
```

**Key insight:** The LLM can autonomously decide to set up heartbeats. If it notices a recurring task during a reactive turn, it can proactively create a heartbeat to monitor it. The user doesn't have to think about scheduling — the agent does it for them.

### 8. `src/routines.js` — Add pause/resume HTTP helpers

Add `pauseRoutine(id, userId)` and `resumeRoutine(id, userId)` exports that the HTTP API can call. These are thin wrappers around `setRoutineEnabled(id, userId, false/true)`.

### 9. HTTP API on `:4098` — New endpoints

```
GET  /state/activity?userId=&type=&limit=    — query activity history
GET  /state/stats?userId=                    — activity stats
GET  /state/heartbeat-sessions               — list heartbeat session mappings
```

## Key Design Decisions

1. **Heartbeat sessions are per-user, not per-channel** — autonomous turns maintain context across fires. A user's heartbeat session is separate from their reactive channel sessions.

2. **Heartbeats DM the user** — autonomous output goes to DMs, not channels. This keeps shared channels clean and makes autonomous results private.

3. **Heartbeats use the same routine scheduler** — they're just a new `type` value. The existing `addRoutine`, `markFired`, `computeNextRun` all work unchanged. The heartbeat tick loop is a thin layer on top that calls the same `onFire` callback.

4. **Activity store is append-only** — no cleanup by default. The store is bounded by the number of turns (not time), so it won't grow unbounded in practice. Could add a TTL cleanup later.

5. **Existing `llm` routines also get activity logging** — this makes the state store useful even without heartbeats.

6. **LLM self-serves heartbeats** — the agent can create, list, pause, resume, and remove its own heartbeats via the routines tool. This means the user can say "check on X every Y hours" in natural language and the LLM handles the scheduling. No slash commands needed for the common case.

7. **Heartbeats are just routines with a different type** — no new persistence layer, no new scheduler. The existing routines infrastructure handles everything. The heartbeat tick loop is ~20 lines that checks for due heartbeats and fires them.

## Implementation Order

1. Create `src/state.js` (persistent store)
2. Create `src/heartbeat.js` (tick scheduler)
3. Modify `src/routines.js` (add heartbeat label, add pause/resume exports)
4. Modify `docker/routines_tool.ts` (add heartbeat type, add pause/resume actions)
5. Modify `src/index.js`:
   - Add `heartbeat` case to `fireRoutine`
   - Add activity recording to existing `llm`/`message` routines
   - Add activity recording to reactive turns
   - Start heartbeat on ready
   - Add `/heartbeat` slash command
   - Add interaction handler for `/heartbeat`
   - Add `/routines/:id/pause` and `/routines/:id/resume` HTTP endpoints
6. Modify `src/opencode.js` (bridge to state store)
7. Add HTTP API endpoints on `:4098` (`/state/activity`, `/state/stats`)

## Testing

- `npm run dev` to test locally (needs DISCORD_TOKEN + opencode serve)
- **Slash command flow:** `/heartbeat add when:every 1m prompt:check disk usage` → verify it fires and DMs the result
- **Self-serve flow:** Tell the bot "remind me every morning to check disk usage" → LLM calls routines tool with `type: "heartbeat"` → verify heartbeat is created → verify it fires next morning
- **Pause/resume:** `/heartbeat pause <id>` → verify it stops firing → `/heartbeat resume <id>` → verify it resumes
- **Activity tracking:** Check `/heartbeat history` shows the activity → verify `/state/activity` HTTP endpoint returns data
- **Persistence:** Restart bot, verify heartbeats resume and session context persists
- **LLM self-manage:** Ask the bot "list my heartbeats" → LLM calls routines tool with `list` → verify it returns the correct list
