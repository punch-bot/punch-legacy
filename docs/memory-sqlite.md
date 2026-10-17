# SQLite memory (PNCH-40)

Requires Node 22.13 or newer, with built-in `node:sqlite` and FTS5. The bot image already uses Node 22. No native npm dependency or database service is needed.

## Cutover

1. Stop the bot before upgrading. Back up its `DATA_DIR`, including `memory.json` and the `memory/` daily-note directory. Do not run old JSON-writing bots against the same state during migration.
2. Start the upgraded bot. Before accepting turns, it creates `memory.sqlite`, imports durable facts and daily notes in one transaction, and records completion in the database. Legacy files remain byte-for-byte unchanged. Malformed input, unreadable files, duplicate record IDs within an owner, or unresolved `.corrupt-*` files abort migration/startup. Restore the source and retry; failed imports leave no partially imported records.
3. Rebuild the sandbox image and recreate sandboxes so the `recall_memory` extension is available. Bot and sandbox updates belong in the same rollout: the new prompt uses that tool. A plain sandbox restart does not install the new image.

Manual preflight against a **copy** of the state, from the repo root:

```sh
DATA_DIR=/absolute/path/to/state-copy node --input-type=module -e 'import { initializeMemory, closeMemory } from "./src/memory.js"; initializeMemory(); closeMemory();'
```

Successful import preserves IDs, ownership, timestamps, and record metadata. Normalized duplicates are reported and preserved; explicit compaction is a separate action. Already lost/truncated legacy facts cannot be reconstructed by migration. The completed import is not rerun, even if stale JSON changes. `memory.sqlite.cutover` prevents missing/empty SQLite from silently reimporting stale sources. Keep it with database backups.

## Runtime behavior

- `remember`, `forget`, list, import, export, compaction, and DM capture retain their public call shapes. Reads use SQLite; mutations use transactions where multiple records change. WAL plus a busy timeout coordinates concurrent writers; a write failure propagates rather than reporting success.
- Data directories isolate bot stacks; owner/scope predicates isolate users and intentionally shared channels. DM notes additionally require the correct user, channel, and DM mode. New daily notes are retained for 30 days, with a 200-record cap per user/channel/day. Legacy source files are never pruned or rewritten by SQLite.
- Search uses FTS5 over normalized tokens and explicit matching rules. Empty/stopword-only queries return nothing. Ordinary terms need three characters; symbolic names such as `C#` remain searchable. Word prefixes are supported, arbitrary interior substrings are not.
- Fact extraction preserves dotted names such as `Next.js`, excludes questions, and saves at most three facts per message. Dedupe preserves significant punctuation.
- Discord and Spectrum turns include a compact hint rather than memory content. `recall_memory` retrieves saved records (hard ceiling 4,000 characters, including citations) and optionally project memory (12,000 characters). It can run with other independent first tools; this is a model routing instruction, not a guarantee that every model batches calls. Measure routing and end-to-end latency in the deployed sandbox.
- `/memory/recall` derives the user from the existing per-sandbox bearer token. A bot-created context ID authorizes the current channel/DM notes, expires after one hour, and is revoked when the turn ends. No context means user facts only. Caller-supplied user/channel IDs cannot widen access.
- Project memory remains at `/work/.punch-memory.md`, managed by core's existing `update_memory` tool. `recall_memory(project:true)` reads it locally alongside bot recall, without the bot fetching it on each turn. Existing session history may still contain previously injected memory until compression/reset.

## Backup and recovery

Stop the bot before copying `memory.sqlite`, any `memory.sqlite-wal`/`memory.sqlite-shm` files, and `memory.sqlite.cutover` together. Alternatively use SQLite's backup API with the database online; copying the main file alone while WAL is active can omit committed data.

If SQLite is damaged or disappears after cutover, restore the complete database backup. Do not delete the cutover marker to make the old JSON import happen automatically: those files do not include post-cutover writes/deletions. To roll back application code, first reconcile/export current SQLite state into the old format under an explicit recovery procedure; preserved pre-migration JSON alone is only a point-in-time recovery option. Sessions, configuration, and thread ownership remain in their existing JSON stores.

## Local validation (2026-10-17)

On Node 24.19.0, the full bot suite passed all 300 tests, including migration rollback/retry, restart persistence, concurrent SQLite writers, scope isolation, five-fix regressions, and Discord/Spectrum recall integration. Bot typecheck/lint passed. The new sandbox extension was also typechecked against the installed `@punch-bot/cli` 1.2.0 and exercised with a mocked authenticated bot response.

A synthetic comparison against the checkout's JSON implementation at `f471259` used 34 durable facts and 6,000 daily records (30 days × 200, approximately 1,800 characters of note text each). After one warm-up, eight selective-query/capture iterations produced these medians:

| Operation | JSON baseline | SQLite |
| --- | ---: | ---: |
| Memory lookup/preamble | 391.7 ms | 5.2 ms |
| DM capture | 1.87 ms | 0.88 ms |

Initial SQLite import took approximately 776 ms. The turn memory hint with its context ID is 447 characters, independent of memory size. These are local storage/prompt measurements on generated data, not deployed model-latency measurements. The JSON baseline does not include the unpublished cache patch discussed in PNCH-34.
