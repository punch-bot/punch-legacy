# Punch

An AI agent living in Discord, designed to be a personal assistant

- **Path:** `/punch`
- **Discord:** production app
- **Agent:** [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`). The bot talks to each sandbox over HTTP; Punch’s `pi-gateway` is an internal adapter only.
- **Deploy:** `docker compose up --build -d` — **bot only**; sandboxes via `/sandbox create`
- **Docs for agents:** [`AGENTS.md`](AGENTS.md)

## What it does

Mention/DM/trigger chat, selective cited memory, durable routines, isolated Pi workers, reviewed Markdown instruction skills, pigeons, browser screenshots, per-sandbox Tailscale, and layered health diagnostics. Discord `/mcp` reports **MCP is not supported yet** for arbitrary user MCP servers.

**Not included:** Composio (`/link`) and arbitrary custom MCP servers. Punch uses Pi, not OpenCode.

## Automations and skills

- `/routine history [id]` shows execution history and delivery errors. Failed delivery uses capped exponential retry backoff. One-shots remove after success but retain history.
- `/routine add` supports IANA timezone, active-hour window, and isolated-session option for LLM automations.
- `/workers start` runs research, coding, or browser work in separate Pi process/session with tool allowlist, 1–30 minute cap, optional model, and DM completion. `/workers list|stop|logs` manages it. `/multitask settings` configures the concurrent worker cap (default 3, max 10).
- Instruction skills live at `/work/.pi/skills/<name>/SKILL.md`. `/skills list|inspect|enable|disable` manages them. Generated skills require proposal then `/skills approve`; Markdown changes apply next turn without Pi restart. Executable tools remain Pi extensions.
- Say “start multiplayer coding with `<sandbox>` in `<workspace>`” to an agent and it uses `collab start`: Git initializes if needed, peer clone is created, and peer agent receives the task. Discord also provides `/collab start <reviewer> <workspace> <task>`. Each proposal is tied to an exact SHA; peer review must inspect and test it. Any new proposal requires a new review. Matching approvals auto-advance canonical `main`.

## Architecture

```
Discord ──▶ [ punch-bot ] ──HTTP──▶ [ sandbox-<name> ]
            :4098                          pi-gateway :4096 → pi --mode rpc
            routines, pigeons                 supervisor :4097
            docker.sock → creates sandboxes
```

- **Bot** — thin client; no Pi on the host required for Docker deploy.
- **Sandbox** — one container per registered user; image installs Pi; built on first `/sandbox create`.

## Quick start

1. `cp .env.example .env` → set `DISCORD_TOKEN`, shared password (`OPENCODE_SERVER_PASSWORD` — legacy env name), optional model (`OPENCODE_MODEL`)
2. `docker compose up --build -d`
3. Discord: `/sandbox create <name> <your_discord_user_id>`
4. `/apikey set anthropic <key>` (or another provider; OpenCode Go: `/apikey set opencode-go <key>`) then mention the bot

Host **4098** = bot HTTP API. Dynamic sandboxes publish **noVNC** from port **16080+** when `VNC_PASSWORD` is set.

## Local dev (optional)

```sh
npm install
# Needs DISCORD_TOKEN + reachable Pi gateway URL — usually easier to use Docker.
npm start
```
