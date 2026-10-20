# Memory (PNCH-47)

Punch keeps five kinds of state that carry context across turns. Each item belongs in exactly one of them. Storage, migration, and recovery details for the SQLite store are in [`memory-sqlite.md`](memory-sqlite.md).

## What goes where

| Store | Holds | Lives in | Written by | Read by |
| --- | --- | --- | --- | --- |
| Saved facts | Short, durable statements about a person (user scope) or a channel (channel scope): names, time zone, preferences, standing instructions, ongoing projects | Bot, `DATA_DIR/memory.sqlite` (`kind = 'fact'`) | `<remember>`/`<forget>` tags, `!remember`, `/memory import`, automatic extraction from DMs, the weekly audit | Core profile, `recall_memory`, `/memory search` |
| Core profile | A view, not a store: at most five user facts / 600 characters, always in the prompt | Derived from saved facts on every turn | Pins (`pinMemory`) and fact edits | Every Discord and Spectrum turn |
| DM daily notes | Automatic `User: … Assistant: …` snippets from private chats, 30-day window | Bot, `DATA_DIR/memory.sqlite` (`kind = 'daily'`) | `captureConversation` after each DM turn | `recall_memory` with a DM context, the weekly audit (read-only) |
| Project memory | Decisions, conventions, gotchas, and open work for the workspace | Sandbox, `/work/.punch-memory.md` | Core's `update_memory` tool, the weekly audit | `recall_memory(project:true)`, `/memory view` |
| Skills | Reusable procedures | Sandbox: `/work/.pi/skills` (workspace), `/data/pi/skills` (user), `/opt/pi/skills` (bundled, read-only) | Pi, skill proposals, the weekly audit (workspace and user roots only) | Pi when a skill is relevant |

Pi session history (`/data/pi/sessions`) is a transcript, not memory. Compaction and resets manage it, and the audit doesn't touch it.

Rules of thumb, also in the bundled `memory` and `project-memory` skills:

- Facts about the person go in saved facts. Facts about a codebase go in project memory. How-to steps go in skills.
- Daily notes are history. They record what was said on a given day, so they are never corrected; they expire after 30 days. The audit uses them only as evidence for fixing facts.
- Channel facts are shared by everyone in the channel. A single user's audit never edits them.

## Write-time rules

These run in the bot inside one SQLite transaction whenever a fact is saved, restated, revised, or imported:

- **Dedupe.** Writing a fact whose normalized text already exists for that scope and owner doesn't insert a row. It refreshes the existing fact's `last_seen`, marks it confirmed, and keeps any pin. Restating a fact is how it gets reconfirmed. Automatic DM extraction goes through the same path.
- **Supersede.** Single-valued facts (`my name is …`, `my time zone is …`) replace any other fact with the same prefix in that scope, including when an existing fact is restated or revised. Imports keep the newest one by timestamp. A pin on a replaced fact carries over.
- **Replace in place.** `<remember replaces="ID">text</remember>` rewrites the cited fact (user scope first, then channel), keeps its id and pin, and marks it confirmed. If the new text duplicates another fact, the two collapse into one. An unknown id falls back to an ordinary save.

## Usage tracking

Schema version 3 adds three columns to `memory_records`:

- `last_seen`: when the fact was written or last restated. Backfilled from `ts`.
- `last_used`: when bot-backed `recall_memory` last returned the fact to Pi, throttled to one write per fact per hour. `/memory search` and `/memory explain` don't count as use. Facts shown in the core profile aren't stamped on every turn; the audit listing marks them as `core profile` instead.
- `confirmed`: `1` by default, `0` when the audit flags a fact as uncertain. `/memory export` writes `confirmed: false` for unconfirmed facts, and `/memory import` restores it. Older exports without the field import as confirmed. Imported facts keep their original `ts` but get the import time as `last_seen`, because an import is a fresh write.

## Weekly audit

### Schedule

Every user registered in `/data/sandbox_users.json` gets one built-in routine of type `memory-audit` in the existing routine store. The bot creates it at startup and after `/sandbox create`, and deletes it after `/sandbox remove` or at the next startup once the user is unregistered. It runs weekly at a fixed time between 03:00 and 05:59 in the user's configured time zone, and setting or clearing the time zone reschedules it. The weekday and minute come from a hash of the user id, so audits don't all run at once. The routine shows in `/routines` lists as `[memory audit]`. It can be paused and resumed but not removed, because the next sync would just recreate it. Failures, including a provider error returned as the turn's reply, use the normal routine backoff and pause after the usual attempt limit.

### Run

When the routine fires, the bot:

1. ensures the sandbox is up and takes the user's run lock, so the audit doesn't overlap Discord turns or other routines for that user. Spectrum turns and memory commands don't take that lock and can still write facts during the audit; see the `apply` rules below;
2. runs exact-duplicate compaction on the user's facts (the same as `/memory compact` without the channel part). A compaction failure is logged and the audit continues;
3. creates an audit context id, valid for two hours and revoked when the turn ends;
4. runs one Pi turn in a fresh session that isn't stored, with a `--- Weekly memory audit ---` block that points Pi at the bundled `memory-audit` skill;
5. delivers nothing and records the one-line summary as a `memory-audit` activity. Memory tags in the reply are not executed, so every fact change goes through the validated `apply` path.

If memory is unavailable, the turn still runs without a context id, and Pi audits only project memory and skills.

### Split

| Part | Where | Why |
| --- | --- | --- |
| Exact-duplicate compaction, dedupe, supersede | Bot, deterministic | Needs no judgment, so it runs as code before any model call |
| Merging near-duplicates, dropping contradicted or stale facts, fixing wrong facts, flagging uncertain ones | Pi, using `memory_audit` through the existing `/bot` bridge | Needs judgment and the evidence in DM notes. Pi already has an authenticated route to the bot (`PUNCH_BOT_URL`, the supervisor `/bot` proxy, the sandbox bearer token), so no bot-side model client is needed |
| Project memory and skills | Pi, editing files in its own sandbox | The bot can't read or write those files without new supervisor routes. Pi already maintains them |

`memory_audit` lives in the existing `memory-recall.ts` deployment extension and calls `POST /memory/audit`:

- `action: "list"` returns user-scope facts 400 at a time with their ids, dates, and pinned, unconfirmed, and core-profile flags. When more remain, the listing names the `offset` for the next page. The first page also includes up to 60 DM notes from the last seven days.
- `action: "apply"` takes up to 200 changes (`add` with `text`, `merge` with `ids` and `text`, `drop` with `id`, `fix` with `id` and `text`, `flag` with `id`) and applies them in one transaction. Pi can send several batches in one run. Any invalid change (dropping a pinned fact, a merge without two ids, empty or secret-looking text) rejects the whole batch with a 400 that names the problem. A change that cites an id that no longer exists is skipped and the reply names the id, because a user correction during the run can supersede the fact Pi listed.
- A change is skipped and counted as `skipped` when any fact it would touch was restated after the audit started. That includes the named ids and the facts its text would collapse into or supersede. A restatement counts when `last_seen` is newer than both the run start and the audit's own last write to that fact. Every write moves `last_seen` forward by at least a millisecond, so two writes in the same millisecond still compare correctly. A user's restatement during the run wins over the audit's earlier listing. An `add` whose text is already saved changes nothing.
- A merge stays unconfirmed when any of its source facts, or an existing fact it collapses into or supersedes, was unconfirmed. A `fix` confirms the fact, because the audit corrected it from evidence.
- The run's totals across all batches are recorded in `memory_meta` under `audit:<userId>`.

Authorization works like recall: the user comes from the sandbox's bearer token, and the request must carry a bot-created audit context id for that user. Recall context ids and ordinary chat turns get 403. A prompt-injected chat turn therefore can't mass-edit memory without the audit's context id, which only the audit turn's prompt carries and which is revoked when that turn ends.

### Uncertain items

Uncertain items stay inside the system and get verified the next time they matter. Nothing is reported to a person.

- **Facts.** `flag` sets `confirmed = 0`. Unconfirmed facts drop out of the core profile unless pinned. Pinned ones stay in it with an `(unconfirmed)` prefix. Recall and `!memories` also show them as `(unconfirmed) …`. The `memory` skill tells Pi to check such a fact with the person when it becomes relevant, then confirm it with `<remember replaces="ID">`, correct it, or `<forget>` it. Restating the fact in conversation also confirms it.
- **Project memory.** The audit prefixes unverifiable lines with `[unconfirmed] `. The `project-memory` skill tells Pi to verify those lines against the workspace when it reads them.
- **Skills.** The audit adds an `Unconfirmed: <reason>` line after the frontmatter instead of deleting the skill. `SYSTEM.md` tells Pi to check such a skill before relying on it and to remove the line once verified.

### Health

`/doctor` reports a `Weekly memory audit` check next to `Memory store`. It shows when the next run is, the counts from the last applied audit, and how many facts are saved and unconfirmed. It warns when the routine is missing or has paused itself after failures, and reports `info` when the user paused it.

## Rollout

The bot changes and the sandbox changes (the `memory_audit` tool, the `memory-audit` skill, the updated `memory`/`project-memory` skills, and `SYSTEM.md`) have to ship together. Rebuild the sandbox image and recreate sandboxes with `/sandbox restart-all recreate:true`. Until a sandbox is recreated, its weekly audit still runs the bot-side exact-duplicate compaction, but Pi has neither the skill nor the tool, so no other fact changes are applied.
