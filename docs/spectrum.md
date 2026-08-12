# Spectrum (Photon) entrypoint

Punch can receive chat through [Spectrum](https://photon.codes/spectrum) as well as Discord. Both entrypoints call the same Pi sandbox agent (`runAgent` → `pi-gateway`).

Official docs:

- [Getting started](https://docs.photon.codes/docs/spectrum-ts/getting-started)
- [iMessage connection and routing](https://docs.photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)
- [Custom events and lifecycle](https://docs.photon.codes/docs/spectrum-ts/custom-events-and-lifecycle)
- [Terminal provider](https://docs.photon.codes/docs/spectrum-ts/providers/terminal/setup-and-usage)

SDK: [`spectrum-ts`](https://www.npmjs.com/package/spectrum-ts) (pinned in `package.json`). Source: [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts).

## Quick start

1. Create a Photon project at [app.photon.codes](https://app.photon.codes/) and copy the project ID and secret.
2. Ensure the Discord bot has created a sandbox for your user: `/sandbox create <name> <discord_user_id>`.
3. Copy `.env.example` → `.env` and set:

```bash
SPECTRUM_MODE=agent
SPECTRUM_PROVIDERS=imessage
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
SPECTRUM_DEFAULT_USER_ID=<same discord_user_id>
```

4. Start the Spectrum process (separate from Discord):

```bash
npm run start:spectrum
```

This entrypoint does **not** require `DISCORD_TOKEN`.

## Modes

| `SPECTRUM_MODE` | Behavior |
|-----------------|----------|
| `agent` (default) | Inbound text → Punch sandbox via `runPunchTurn` / `runAgent` |
| `echo` | Minimal echo/reply (official Spectrum sample shape) for local smoke |

## Providers

`SPECTRUM_PROVIDERS` is a comma-separated list:

- `imessage` — managed Spectrum Cloud lines (`imessage.config()`). Requires project credentials.
- `terminal` — local TUI / non-TTY readline (`terminal.config()`). No Photon credentials.

Local smoke without cloud credentials:

```bash
SPECTRUM_MODE=echo SPECTRUM_PROVIDERS=terminal npm run start:spectrum
```

Do **not** use `@spectrum-ts/imessage-local` in Punch (macOS-only Messages database).

## Identity mapping

Punch sandboxes are keyed by Discord user IDs. Spectrum senders map to those IDs via:

1. `SPECTRUM_USER_MAP` JSON (`"+1555…"` / email / sender id → Punch user id)
2. Else `SPECTRUM_DEFAULT_USER_ID`

Sessions are stored under `spectrum:<space.id>` so they do not collide with Discord channel sessions.

## Architecture

```
Spectrum (iMessage / terminal)
  → src/spectrum.js
  → src/punch-turn.js
  → src/agent.js runAgent
  → sandbox pi-gateway :4096
```

Discord continues to use `src/index.js` unchanged.
