# Spectrum (Photon) entrypoint

Punch can receive chat through [Spectrum](https://photon.codes/spectrum) as well as Discord. Both call the same Pi sandbox agent (`runAgent` → `pi-gateway`).

**Default:** once Photon credentials are in `.env`, Spectrum starts **automatically with the Discord bot** (`docker compose up` / `npm start`). You do not need a separate process.

Official docs:

- [Getting started](https://docs.photon.codes/docs/spectrum-ts/getting-started)
- [iMessage connection and routing](https://docs.photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)
- [Custom events and lifecycle](https://docs.photon.codes/docs/spectrum-ts/custom-events-and-lifecycle)
- [Terminal provider](https://docs.photon.codes/docs/spectrum-ts/providers/terminal/setup-and-usage)

SDK: [`spectrum-ts`](https://www.npmjs.com/package/spectrum-ts) (pinned in `package.json`). Source: [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## One-time setup (then always on)

1. Create a Photon project at [app.photon.codes](https://app.photon.codes/) and copy the project ID and secret. Enable iMessage for the project.
1. Create your Punch sandbox in Discord: `/sandbox create <name> <your_discord_user_id>`.
1. Put this in `.env` (compose already loads `.env` into the bot):

```bash
SPECTRUM_MODE=agent
SPECTRUM_PROVIDERS=imessage
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
SPECTRUM_USER_MAP={"+15551234567":"<your_discord_user_id>"}
```

1. Rebuild/restart the bot:

```bash
npm install   # host/local
docker compose up --build -d
```

On Discord ready you should see:

```text
[spectrum] starting alongside Discord (mode=agent providers=imessage)
```

### Enable / disable

| Env | Behavior |
|-----|----------|
| (unset) + project id/secret set | **Auto-start** with the bot |
| `SPECTRUM_ENABLED=1` | Always try to start (still validates config) |
| `SPECTRUM_ENABLED=0` | Never start Spectrum |

Optional standalone (debug only): `npm run start:spectrum` — same code path, no Discord.

## Modes

| `SPECTRUM_MODE` | Behavior |
|-----------------|----------|
| `agent` (default) | Inbound text → Punch sandbox via `runPunchTurn` / `runAgent` |
| `echo` | Minimal echo/reply for local smoke |

## Providers

`SPECTRUM_PROVIDERS` is a comma-separated list:

- `imessage` — managed Spectrum Cloud lines (`imessage.config()`). Requires project credentials. Agent mode also requires `SPECTRUM_USER_MAP`.
- `terminal` — local TUI / non-TTY readline (`terminal.config()`). No Photon credentials. May use `SPECTRUM_DEFAULT_USER_ID`.

Local smoke without cloud credentials:

```bash
npm install
SPECTRUM_MODE=echo SPECTRUM_PROVIDERS=terminal npm run start:spectrum
```

Do **not** use `@spectrum-ts/imessage-local` in Punch (macOS-only Messages database).

## Identity mapping

Punch sandboxes are keyed by Discord user IDs.

1. **iMessage agent mode (required):** `SPECTRUM_USER_MAP` JSON (`"+1555…"` / email / sender id → Punch user id). Unmapped senders are rejected.
1. **Terminal only (optional):** `SPECTRUM_DEFAULT_USER_ID` as a local fallback when the map has no hit.

Sessions are stored under `spectrum:<userId>:<space.id>` so they do not collide with Discord channel sessions or other Punch users in a shared space.

## Architecture

```text
Discord + Spectrum (same bot process)
  → src/index.js (Discord) + src/spectrum/boot.js (Photon)
  → src/punch-turn.js
  → src/agent.js runAgent
  → sandbox pi-gateway :4096
```
