# Punch Nightly — operations

> **Warning:** The **"Cursor Cloud specific instructions"** in `AGENTS.md` (Firecracker VM, `dockerd` startup, `fuse-overlayfs` `daemon.json`, cgroup quirks) are **irrelevant** here. This runs on a **normal computer with a standard Docker daemon** — do not assume the VM environment or apply that setup guidance.

Experimental stack at **`/Punch Nightly`**. Production is **`/punch`** — separate compose project, Discord app, volumes, and code path.

Nightly is **Pi everywhere** from user perspective. `pi-gateway` is an internal HTTP adapter only.

## Start / stop

```sh
cd "/Punch Nightly"
docker compose up --build -d
docker compose logs -f bot
docker compose down
```

- **Compose project:** `punch-nightly`
- **Network:** `punch-nightly_edge`
- **Bot HTTP:** host **4099**, container 4098

## Spectrum (Photon)

iMessage via `spectrum-ts` runs **in the bot process** when Photon credentials are in `.env` (auto-start). Same Punch sandboxes as Discord.

```sh
# In .env: SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, SPECTRUM_USER_MAP
# Then:
docker compose up --build -d
# Look for: [spectrum] starting alongside Discord
```

Force off: `SPECTRUM_ENABLED=0`. Standalone debug: `npm run start:spectrum`. See `docs/spectrum.md`.
## Sandboxes

Compose does not start a sandbox. Per Discord user:

```text
/sandbox create <name> <discord_user_id>
/sandbox list
/sandbox remove <name>
```

Set provider keys through `/apikey` or `/env`, then select a model through `/models`.

Containers use `punch-nightly_sandbox-<name>_1` and DNS `sandbox-<name>`. Image: `punch-nightly-sandbox:latest`. Tailscale state persists per sandbox.

## Memory v2

Memory retrieval is keyword-ranked and bounded instead of injecting every saved fact. `/memory search <query>` shows matching sources, `/memory explain <query>` includes ranking reasons, and `/memory compact` removes normalized duplicates.

Successful DM turns create bounded daily notes for cross-session recall and extract only high-confidence durable facts from user text. Secret-like values are redacted or skipped. Daily notes are never recorded or retrieved in guild/channel conversations.

## Diagnostics

`/doctor` checks routing, Docker, Pi, provider, storage, scheduler, browser, Tailscale, extensions, and security. `/doctor deep:true` adds filesystem and isolated Chromium probes. Discord administrators may target another sandbox with `/doctor sandbox:<name>`. Failed checks expose scoped repair buttons; browser reset requires confirmation.

## Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_TOKEN` | Nightly Discord app |
| `PI_SERVER_PASSWORD` | Shared wire authentication (legacy `OPENCODE_SERVER_PASSWORD` still read as fallback) |
| `PUNCH_STACK_NAME` | `punch-nightly` |
| `PUNCH_SANDBOX_IMAGE` | `punch-nightly-sandbox:latest` |
| `PI_MODEL` | Default model (legacy `OPENCODE_MODEL` still read as fallback) |

`PI_SERVER_URL` stays empty; routing uses dynamic registry.

## Feature differences

- Composio remains absent.
- Custom MCP servers work via Discord `/mcp` (list/add/remove/auth) and Pi core's native MCP inside the sandbox. OAuth is deferred; API keys use `/mcp auth`.
- Tailscale is included with persistent per-sandbox state.
- Nightly uses Pi through internal `pi-gateway`.
- Browser tools come from built-in Pi extension.

## Coexistence with prod

Nightly and prod use separate compose names, networks, volumes, Discord apps, and host ports.

## Developer docs

`AGENTS.md` is canonical coding-agent guide. `README.md` is human overview.
