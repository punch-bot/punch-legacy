# Punch — agent guide

Punch is a personal assistant that lives in Discord and, optionally, iMessage via Spectrum. The bot is a thin client. Each registered user gets their own Docker sandbox running **Pi** from [`punch-bot/core`](https://github.com/punch-bot/core) (`@punch-bot/cli`, `pi --mode rpc`).

## Branches and stacks

- `main` is the only long-lived branch. The `nightly` branch no longer exists, so open every PR against `main`.
- `.env` sets the stack identity. `PUNCH_STACK_NAME` (`punch` or `punch-nightly`) determines the compose project, network, volume prefix, and sandbox image name. No host ports are published: the bot and sandboxes talk over the compose network. Before you run `docker compose`, check which stack the current checkout drives.

## Commands

```sh
npm install
npm test             # node --test test/*.mjs, no Docker needed
npm run typecheck
npm run lint         # Spectrum files only
docker compose up --build -d && docker compose logs -f bot
docker compose build sandbox   # rebuild the sandbox image (profile: sandbox)
```

Compose needs a `.env` file. It's gitignored, so copy it from `.env.example`. Without `DISCORD_TOKEN` the bot exits immediately.

## Tests and checks

Writing tests is strictly forbidden unless you're adding new functionality. Bug fixes, refactors, cleanups, and behavior tweaks don't get new tests, and you don't add tests to existing code. When a change does add new functionality, write the fewest tests that cover it.

Never change the thing that judges your work to make your work pass. That covers tests, assertions, fixtures, lint and type configs, timeouts, thresholds, and the task's own requirements. Don't skip, loosen, or delete them, and don't special-case code for them. When a check fails, fix the code. If you think the check itself is wrong, stop and say so rather than editing it.

## Architecture

```
Discord / Spectrum → bot :4098 → http://sandbox-<name>:4096 (pi-gateway) → pi --mode rpc
                                 http://sandbox-<name>:4097 (supervisor)
```

- By default, compose runs only `bot` and `searxng`. Sandboxes are created at runtime by `/sandbox create <name> <userid>` through the Docker socket (`src/sandbox-manager.js`).
- `serverFor(userId)` in `src/agent.js` routes through `/data/sandbox_users.json` (plus `SANDBOX_MAP`). There is no default sandbox, so unregistered users get no LLM turns.
- `pi-gateway.mjs` is an internal HTTP adapter over Pi RPC that handles sessions, messages, SSE events, abort, steer, compact, and files. User-facing copy says Pi, never "gateway".
- `serve-supervisor.mjs` owns the gateway child process and the sandbox API. For the current routes, see `supervisor/routes.mjs`.
- When `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` are set, Spectrum boots inside the bot process. See `docs/spectrum.md`.

## Layout

| Path | Role |
|------|------|
| `src/index.js` | Bootstrap only |
| `src/core/` | Shared config, client registry, Discord helpers, supervisor auth |
| `src/chat/` | Message triggers, per-user turn queue, full chat turn, threads, steer, turn/worker status |
| `src/commands/` | Slash command definitions, interaction handlers, `!` prefix commands |
| `src/gateway/` | Bot HTTP API (:4098) and pigeon delivery |
| `src/agent.js` | Pi gateway client, routing, timeouts, context limits |
| `src/prompt-blocks.js` | Builders for every `--- name ---` prompt section |
| `src/memory.js` | Memory retrieval, durable facts, DM-only daily notes |
| `src/routines.js`, `src/heartbeat.js` | Durable routine store and scheduler tick |
| `src/punch-turn.js`, `src/spectrum/` | Non-Discord turn path and the iMessage entrypoint |
| `src/doctor/` | Bot-side diagnostics (the sandbox side is `usr/local/lib/doctor.mjs`) |
| `docker/sandbox/` | Mirrors the sandbox image filesystem, copied to `/` (`opt/pi/` for extensions, skills, and `SYSTEM.md`; `usr/local/` for the gateway, supervisor, and workers) |

## Inside a sandbox

- `/work` is the workspace. User extensions go in `/work/.pi/extensions/*.ts`, skills in `/work/.pi/skills/<name>/SKILL.md`, and the prompt addendum in `/work/.pi/SYSTEM.md`.
- Skill precedence is workspace, then user (`/data/pi/skills`), then bundled (`/opt/pi/skills`).
- The supervisor writes provider keys to `/data/pi/agent/auth.json`. Sessions live in `/data/pi/sessions`, and logical session ids in `/data/pi/gateway-sessions.json`.
- Facts and DM daily notes live in `DATA_DIR/memory.sqlite` (Node >=22.13). Startup imports legacy JSON transactionally and preserves the sources. Migration failure disables memory, keeps the bot online, and is reported by `/doctor`. See `docs/memory-sqlite.md` before rollback or recovery.
- Project memory lives in `/work/.punch-memory.md`. Turns include a core user profile (up to 5 items/600 chars) plus a compact recall hint; the `recall_memory` deployment extension reads project memory only on demand (up to 12k chars). Keep that cap in sync with `MAX_MEMORY_CHARS` in core's context-pruning extension. Bot-backed recall is capped at 4k chars and authorized by sandbox identity plus a bot-created turn context. Managed sandboxes receive `PUNCH_BOT_TOKEN` and `PUNCH_BOT_URL` (default `http://bot:4098`) at creation/recreation.

## Gotchas

- Keep the default `PI_VERSION` in `docker/sandbox.Dockerfile` aligned with `@punch-bot/cli` and `@punch-bot/ai` in `docker/sandbox/opt/pi/package.json`. Keep Playwright aligned with the CLI's version so both use the installed Chromium build.
- The runtime bundles browser, webfetch, progress, context-pruning, collaboration, routines, and MCP tools. SearXNG and the memory-recall deployment bridge are seeded from this repo. On recreation, old bundled extensions move to `/work/.pi/extensions/.legacy-pi`, preserving user edits without loading duplicate tools.
- Changes under `docker/` reach users only after the sandbox image is rebuilt and the sandboxes are recreated with `/sandbox restart-all recreate:true`. A plain restart keeps the old image and env.
- No provider is bundled. Turns fail until a key is set with `/apikey set <provider> <key>` or `/env`.
- Bot↔sandbox auth is HTTP basic with `PI_SERVER_USERNAME` (default `pi`) and `PI_SERVER_PASSWORD`. On the bot side, use `supervisorAuth()` from `src/core/config.js` rather than building the header inline.
- The only remaining `opencode` references are deliberate. `opencode` and `opencode-go` are model providers, and they share the `OPENCODE_API_KEY` key. `.github/workflows/opencode.yml` runs the issue-comment coding agent. Everything else uses Pi names.
