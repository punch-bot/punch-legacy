# SQLite memory (PNCH-40)

Requires Node 22.13 or newer, with built-in `node:sqlite` and FTS5. The bot image already uses Node 22. No native npm dependency or database service is needed.

## Cutover

1. Stop the bot before upgrading. Back up its `DATA_DIR`, including `memory.json` and the `memory/` daily-note directory. Do not run old JSON-writing bots against the same state during migration.
2. Start the upgraded bot. It creates `memory.sqlite`, imports durable facts and daily notes in one transaction, and records completion in the database. Legacy files remain byte-for-byte unchanged. Malformed input, unreadable files, or unresolved `.corrupt-*` files abort migration and disable memory; the bot continues running, with `/doctor` reporting the source that needs repair. Failed imports leave no partially imported records and cannot enable writes to an empty fallback. Repair the source, then restart the bot (or explicitly call `initializeMemory()` to retry in a controlled maintenance session). The manual preflight below remains strict and throws on failure.
3. Rebuild the sandbox image and recreate sandboxes so the `recall_memory` extension is available. Bot and sandbox updates belong in the same rollout: the new prompt uses that tool. A plain sandbox restart does not install the new image.

Manual preflight against a **copy** of the state, from the repo root:

```sh
DATA_DIR=/absolute/path/to/state-copy node --input-type=module -e 'import { initializeMemory, closeMemory } from "./src/memory.js"; initializeMemory(); closeMemory();'
```

Successful import preserves ownership, timestamps, and record metadata. When legacy IDs collide within an owner/scope, the first ID is retained and subsequent records receive deterministic replacement IDs with the original recorded as `legacyId`. Both records survive, and warnings identify the file, owner, original ID, and replacement ID. Normalized duplicate text is reported and preserved; explicit compaction is a separate action. Already lost/truncated legacy facts cannot be reconstructed by migration. The completed import is not rerun, even if stale JSON changes. `memory.sqlite.cutover` prevents missing/empty SQLite from silently reimporting stale sources. Keep it with database backups.

## Runtime behavior

- `remember`, `forget`, list, import, export, compaction, and DM capture retain their public call shapes. Reads use SQLite; mutations use transactions where multiple records change. WAL plus a busy timeout coordinates concurrent writers; a write failure propagates rather than reporting success.
- Data directories isolate bot stacks; owner/scope predicates isolate users and intentionally shared channel facts. Daily notes require the correct user, channel, and DM mode. This preserves the pre-migration `candidates()`/`captureConversation()` behavior: guild chats neither captured nor recalled daily notes. Imported daily records, including records with guild-looking channel IDs, remain private and are not exposed by guild recall. They are preserved in SQLite and the original JSON; enabling guild daily notes would require an explicit scope/privacy migration. Durable channel facts remain available in guild chats.
- Daily notes have a 30-day recall window and a 200-record cap per user/channel/day. Capture prunes expired rows only for the active user/channel using its index; it does not sweep other tenants. Inactive scopes can retain expired rows physically until their next capture, but those rows are already excluded from recall. Legacy source files are never pruned or rewritten by SQLite.
- Search uses FTS5 over normalized tokens and explicit matching rules. Empty/stopword-only queries return nothing. Ordinary terms need three characters; symbolic names such as `C#` remain searchable. Word prefixes are supported, arbitrary interior substrings are not.
- Fact extraction preserves dotted names such as `Next.js`, excludes questions, and saves at most three facts per message. Dedupe preserves significant punctuation.
- Discord and Spectrum always include a core profile capped at five items and 600 characters, plus the compact recall hint. Explicitly pinned user facts come first, then name/time-zone/preference facts, then stable oldest user facts to fill spare slots. A configured time zone uses one slot. Sensitive text is excluded, and each fact is individually bounded so a long item cannot consume the whole tier. Other users' and channel facts cannot enter this profile. Use `remember(..., { pinned: true })` or `pinMemory(scope, ownerId, id, pinned)` to manage persistence of pins; portable exports/imports preserve pins, and compaction prefers pinned copies. Pin changes update this small tier; ordinary non-profile edits do not expand the always-on prompt. Schema version 2 upgrades existing version-1 databases without reimporting JSON.
- `recall_memory` retrieves the rest of saved memory (hard ceiling 4,000 characters, including citations) and optionally project memory (12,000 characters). It can run with other independent first tools; this is a model routing instruction, not a guarantee that every model batches calls. Measure routing and end-to-end latency in the deployed sandbox.
- `/memory/recall` derives the user from the existing per-sandbox bearer token. A bot-created context ID authorizes the current channel/DM notes, expires after one hour, and is revoked when the turn ends. No context means user facts only. Caller-supplied user/channel IDs cannot widen access.
- Managed sandbox creation injects `PUNCH_BOT_TOKEN` and `PUNCH_BOT_URL` (default `http://bot:4098`) and attaches the sandbox to the bot's Compose network. Token resolution remains tied to the registered sandbox owner. The Compose `sandbox` profile is only a base image/container, not a registered user's authenticated sandbox. Existing containers need recreation to receive the new image/environment; override `PUNCH_BOT_URL` in the bot's deployment environment if its service address differs. Container argument wiring is tested; live Docker/DNS reachability still needs rollout validation.
- Project memory remains at `/work/.punch-memory.md`, managed by core's existing `update_memory` tool. `recall_memory(project:true)` reads it locally alongside bot recall, without the bot fetching it on each turn. Existing session history may still contain previously injected memory until compression/reset.

## Injection diagnostics (PNCH-45)

Every successful `preamble()` call logs `[memory] recall-preamble chars=N
approxTokens=N/4`, including empty/disabled-budget results. Its 4,000-character
ceiling includes citation prefixes, truncation markers, and line separators;
callers can only lower it. Each Discord/Spectrum memory block logs its actual
assembled size as `[memory] turn-memory-block chars=N approxTokens=N/4`, including
the bounded profile, recall hint, and block delimiters. These logs contain sizes
only; they do not include queries, facts, identities, or context IDs. The token
count is a character-based estimate, not provider token accounting.

When investigating repeated facts, first inspect the corresponding turn's core
profile, recall tool results/citations (`memory:user`, `memory:channel`, or
`daily`), any requested project-memory result, and quoted/session history. The
always-on block is a profile and hint; a repeated fact may also come from daily
notes, project memory, or old conversation context. Size logs identify which
payload was sent and its budget, but cannot establish which source the model
used. No production recitation trace was supplied for this change.

## Backup and recovery

Stop the bot before copying `memory.sqlite`, any `memory.sqlite-wal`/`memory.sqlite-shm` files, and `memory.sqlite.cutover` together. Alternatively use SQLite's backup API with the database online; copying the main file alone while WAL is active can omit committed data.

If SQLite is damaged or disappears after cutover, memory stays disabled while normal bot chat/settings remain usable; `/doctor` and the startup log show the recovery error. Memory writes and recall fail explicitly, and prompts state that saved memory is unavailable. Restore the complete database backup. Do not delete the cutover marker to make the old JSON import happen automatically: those files do not include post-cutover writes/deletions. To roll back application code, first reconcile/export current SQLite state into the old format under an explicit recovery procedure; preserved pre-migration JSON alone is only a point-in-time recovery option. Sessions, configuration, thread ownership, and legacy environment settings remain in their existing JSON stores. This migration does not encrypt secrets or convert configuration storage.

Model-emitted `<remember>`/`<forget>` annotations cannot discard a completed answer. The shared handler strips the tags even when writes fail, counts only successful changes, and reports failures separately. Discord replies, heartbeats, and scheduled automations deliver the answer with a memory-update failure note; failed annotations do not trigger automatic fact extraction as a fallback. Prefix commands (`!remember`, `!forget`, `!memories`) and `/memory` report that the store is unavailable instead of throwing out of their handlers.

## Local validation (2026-10-17)

On Node 24.19.0, the full bot suite passed all 312 tests, including migration rollback/retry, ID-collision preservation, schema upgrades, pinned-profile persistence/bounds, scoped pruning, disabled-memory chat/routine delivery, failed/partial memory-tag mutations, sandbox arguments, concurrent SQLite writers, scope isolation, and five-fix regressions. Bot typecheck/lint passed. The sandbox extension was also typechecked against the installed `@punch-bot/cli` 1.2.0 and exercised with a mocked authenticated bot response and custom bot URL.

A synthetic comparison against the checkout's JSON implementation at `f471259` used 34 durable facts and 6,000 daily records (30 days × 200, approximately 1,800 characters of note text each). SQLite measurements include the core profile read. After one warm-up, eight selective-query/capture iterations produced these medians:

| Operation | JSON baseline | SQLite |
| --- | ---: | ---: |
| Memory lookup/preamble | 422.8 ms | 5.5 ms |
| DM capture | 2.23 ms | 0.54 ms |

Initial SQLite import took approximately 1,043 ms. The recall hint with its context ID is 447 characters, independent of memory size; the core tier adds at most 600 profile characters plus its label. These are local storage/prompt measurements on generated data, not deployed model-latency measurements. The JSON baseline does not include the unpublished cache patch discussed in PNCH-34. SQLite uses WAL with `synchronous=FULL`.
