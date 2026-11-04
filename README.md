# Punch

An AI agent living in Discord, designed to be a personal assistant

- **Path:** `/punch`
- **Discord:** production app
- **Agent:** Punch's [Pi runtime](https://github.com/punch-bot/core) (`@punch-bot/cli`). The bot talks to each sandbox over HTTP; Punch's `pi-gateway` is an internal adapter only.
- **Deploy:** `docker compose up --build -d` — **bot only**; sandboxes via `/sandbox create`
- **Docs for agents:** [`AGENTS.md`](AGENTS.md)

## What it does

Mention/DM/trigger chat, selective cited memory, durable routines, isolated Pi workers, reviewed Markdown instruction skills, pigeons, browser screenshots, per-sandbox Tailscale, layered health diagnostics, Discord voice-memo speech-to-text, and custom MCP servers via Discord `/mcp` (loaded by the Punch runtime).

**Not included:** Composio (`/link`). MCP OAuth is deferred — use `/mcp auth` for API keys, or pass custom bearer tokens via `/mcp add` headers or environment.

## Automations and skills

- `/routine history [id]` shows execution history and delivery errors. Failed delivery uses capped exponential retry backoff. One-shots remove after success but retain history.
- `/routine add` supports IANA timezone, active-hour window, and isolated-session option for LLM automations.
- `/workers start` runs research, coding, or browser work in separate Pi process/session with tool allowlist, 1–30 minute cap, optional model, and DM completion. `/workers list|stop|logs` manages it. `/workers cap [value]` shows or sets the concurrent worker cap (default 3, max 10).
- `/settings threads enable` (or `!settings threads on`) opens a Punch-owned thread per summon; the summoner's later messages inside it summon automatically without a mention. By default, a message sent in the same channel while Punch is working steers the running turn (Pi `steer`) instead of queueing behind it; `/settings steering disable` turns that off.
- Skills live at `/work/.pi/skills/<name>/SKILL.md`, `/data/pi/skills`, and `/opt/pi/skills`. `/skills list|inspect|enable|disable` manages them. Generated skills require proposal then `/skills approve`. Pi discovers skills when loading a session or reloading resources, includes their descriptions and paths in its system prompt, and lets the agent read relevant skill bodies on demand. Executable tools remain Pi extensions.
- Say “start multiplayer coding with `<sandbox>` in `<workspace>`” to an agent and it uses `collab start`: Git initializes if needed, peer clone is created, and peer agent receives the task. Discord also provides `/collab start <reviewer> <workspace> <task>`. Each proposal is tied to an exact SHA; peer review must inspect and test it. Any new proposal requires a new review. Matching approvals auto-advance canonical `main`.

## Architecture

```
Discord ──▶ [ punch-bot ] ──HTTP──▶ [ sandbox-<name> ]
            :4098                          pi-gateway :4096 → pi --mode rpc
            routines, pigeons                 supervisor :4097
            docker.sock → creates sandboxes

Spectrum ─▶ [ npm run start:spectrum ] ──HTTP──▶ same sandbox pi-gateway
            (iMessage / terminal via spectrum-ts)
```

- **Bot** — thin client; no Pi on the host required for Docker deploy.
- **Sandbox** — one container per registered user; image installs Pi; built on first `/sandbox create`.
- **Spectrum** — Photon iMessage (and optional terminal) starts **with the bot** when `SPECTRUM_*` is set in `.env` ([docs/spectrum.md](docs/spectrum.md)).

## Quick start

1. `cp .env.example .env` → set `DISCORD_TOKEN`, fallback password for unmanaged sandboxes (`PI_SERVER_PASSWORD`; managed sandboxes get their own), optional model (`PI_MODEL`)
2. Optional iMessage/Spectrum: set `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` in `.env` — Spectrum starts with the bot; unknown numbers pair via `/pair` (see [docs/spectrum.md](docs/spectrum.md))
3. `docker compose up --build -d`
4. Discord: `/sandbox create <name>`
5. `/apikey set anthropic <key>` (or another provider), or `/chatgpt signin` to use a ChatGPT Plus/Pro subscription with a one-time code, then mention the bot (or text Punch after `/pair`)

Host **4098** = bot HTTP API. Sandboxes run a headless Chromium (Playwright) for the built-in browser tools; screenshots attach to Discord automatically.

## Local dev (optional)

```sh
npm install
# Needs DISCORD_TOKEN + reachable Pi gateway URL — usually easier to use Docker.
npm start
```
