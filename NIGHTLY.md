# Punch Nightly — operations

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

Optional second chat entrypoint for iMessage (and local terminal smoke) via `spectrum-ts`. Same Punch sandboxes as Discord.

```sh
# After /sandbox create and SPECTRUM_* in .env — see docs/spectrum.md
npm run start:spectrum
```

## Sandboxes

Compose does not start a sandbox. Per Discord user:

```text
/sandbox create <name> <discord_user_id>
/sandbox list
/sandbox remove <name>
```

Set provider keys through `/apikey` or `/env`, then select a model through `/models`.

Containers use `punch-nightly_sandbox-<name>_1` and DNS `sandbox-<name>`. Image: `punch-nightly-sandbox:latest`. VNC ports start at `26080+` when configured. Tailscale state persists per sandbox.

## Memory v2

Memory retrieval is keyword-ranked and bounded instead of injecting every saved fact. `/memory search <query>` shows matching sources, `/memory explain <query>` includes ranking reasons, and `/memory compact` removes normalized duplicates.

Successful DM turns create bounded daily notes for cross-session recall and extract only high-confidence durable facts from user text. Secret-like values are redacted or skipped. Daily notes are never recorded or retrieved in guild/channel conversations.

## Diagnostics

`/doctor` checks routing, Docker, Pi, provider, storage, scheduler, browser, Tailscale, extensions, and security. `/doctor deep:true` adds filesystem and isolated Chromium probes. Discord administrators may target another sandbox with `/doctor sandbox:<name>`. Failed checks expose scoped repair buttons; browser reset requires confirmation.

## Environment

| Variable | Purpose |
|----------|---------|
| `DISCORD_TOKEN` | Nightly Discord app |
| `OPENCODE_SERVER_PASSWORD` | Legacy alias for shared wire authentication |
| `PUNCH_STACK_NAME` | `punch-nightly` |
| `PUNCH_SANDBOX_IMAGE` | `punch-nightly-sandbox:latest` |
| `PUNCH_VNC_PORT_BASE` | Nightly VNC base, normally `26080` |
| `OPENCODE_MODEL` | Legacy alias for default model |

`OPENCODE_SERVER_URL` stays empty; routing uses dynamic registry.

## Feature differences

- Composio remains absent.
- Custom MCP servers work via Discord `/mcp` (list/add/remove/auth) and `pi-mcp-adapter` inside the sandbox. OAuth is deferred; API keys use `/mcp auth`.
- Tailscale is included with persistent per-sandbox state.
- Nightly uses Pi through internal `pi-gateway`.
- Browser tools come from built-in Pi extension.

## Coexistence with prod

Nightly and prod use separate compose names, networks, volumes, Discord apps, and host ports.

## Developer docs

`AGENTS.md` is canonical coding-agent guide. `README.md` is human overview.
