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
1. Ensure the Discord bot has created a sandbox for your user: `/sandbox create <name> <discord_user_id>`.
1. Copy `.env.example` → `.env` and set:

```bash
SPECTRUM_MODE=agent
SPECTRUM_PROVIDERS=imessage
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
SPECTRUM_USER_MAP={"+15551234567":"<discord_user_id>"}
```

1. Install host dependencies, then start the Spectrum process (separate from Discord):

```bash
npm install
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

- `imessage` — managed Spectrum Cloud lines (`imessage.config()`). Requires project credentials and `SPECTRUM_USER_MAP`.
- `terminal` — local TUI / non-TTY readline (`terminal.config()`). No Photon credentials. May use `SPECTRUM_DEFAULT_USER_ID`.

Local smoke without cloud credentials:

```bash
npm install
SPECTRUM_MODE=echo SPECTRUM_PROVIDERS=terminal npm run start:spectrum
```

Do **not** use `@spectrum-ts/imessage-local` in Punch (macOS-only Messages database).

## Identity mapping

Punch sandboxes are keyed by Discord user IDs.

1. **iMessage (required):** `SPECTRUM_USER_MAP` JSON (`"+1555…"` / email / sender id → Punch user id). Unmapped senders are rejected.
1. **Terminal only (optional):** `SPECTRUM_DEFAULT_USER_ID` as a local fallback when the map has no hit.

Sessions are stored under `spectrum:<userId>:<space.id>` so they do not collide with Discord channel sessions or other Punch users in a shared space.

## Architecture

```text
Spectrum (iMessage / terminal)
  → src/spectrum.js
  → src/punch-turn.js
  → src/agent.js runAgent
  → sandbox pi-gateway :4096
```

Discord continues to use `src/index.js` unchanged.
