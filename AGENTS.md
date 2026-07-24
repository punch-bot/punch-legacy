# Punch Nightly — agent guide

**Workspace path:** `/Punch Nightly`  
**Production Punch (do not edit unless asked):** `/punch`

This tree is an **experimental fork** of Punch: same Discord + per-user sandbox model, powered by **Pi** (`@earendil-works/pi-coding-agent`), with an **isolated Docker stack**, **separate Discord app**, **per-sandbox Tailscale**, and **no Composio or compose bootstrap sandbox** (no `sandbox-juniper`).

| | Prod `/punch` | **Nightly** (`/Punch Nightly`) |
|--|---------------|--------------------------------|
| Compose project | `punch` | `punch-nightly` |
| Docker network | `punch_edge` | `punch-nightly_edge` |
| Volume prefix | `punch_` | `punch-nightly_` |
| Bot HTTP on host | `4098` | **`4099`** → container `4098` |
| Dynamic VNC base | `16080+` | **`26080+`** (`PUNCH_VNC_PORT_BASE`) |
| Default sandbox in compose | often yes (juniper) | **no** — only `bot` service |
| Coding agent | OpenCode | **Pi** (`pi --mode rpc`) via Punch `pi-gateway` on `:4096` |
| Default sandbox URL | set in compose | **empty** — routing via registry only |
| Composio `/link`, bot MCP proxy | yes | **removed** |
| Tailscale `/tailscale` | yes | **included** (persistent per-sandbox state) |
| Host agent install | only for `make-min-auth` | **not** required for `docker compose` |

**First-time use:** every Discord user needs **`/sandbox create <name> <discord_user_id>`** once. Unregistered users cannot get LLM turns (`serverFor` → null).

```sh
cd "/Punch Nightly"
docker compose up --build -d
docker compose logs -f bot
# Then: /sandbox create <name> <discord_user_id>
# Set a provider key: /apikey set anthropic <key>  (or /env set ANTHROPIC_API_KEY ...)
```

More ops detail: `NIGHTLY.md`. Human overview: `README.md`.

---

## Pi (Nightly v1)

Nightly sandboxes run **Pi** (`pi --mode rpc`). Punch’s `docker/pi-gateway.mjs` is an **internal HTTP adapter** on `:4096` so the Discord bot can keep a simple session/message/SSE client (`POST /session`, `POST /session/{id}/message`, `GET /event`, summarize/abort/file). Users and Discord copy should say **Pi**, not the gateway protocol. Bot routing (`http://sandbox-<name>:4096`) and supervisor (`:4097`) stay the same.

| Works in v1 | Deferred / gaps |
|-------------|-----------------|
| Discord chat turns via Pi gateway | Migrating old non-Pi session DBs (use Pi session files under `/data/pi/sessions`) |
| Abort / `!stop` (client disconnect → Pi `abort`) | |
| `/reset` (new session), `/compress` (Pi `compact`) | MCP into Pi — Discord `/mcp` refuses with **not supported yet** (supervisor may still keep an unused registry) |
| `/models`, `/env`, `/apikey`, `/secrets`, `/tailscale`, `/doctor`, `/memory`, `/skills`, `/workers` | Legacy `/work/.opencode/tools` (not loaded; only `/work/.pi/extensions` reload) |
| Built-in Pi tools: bash, read, write, edit; isolated worker Pi processes | Full multi-session concurrency for main chat gateway (it switches logical sessions) |
| **Browser** via Pi extension `browser.ts` (`puppeteer_*` tools; screenshots auto-attach to Discord) | Third-party serve shims not used |
| Progress SSE → Discord thinking UI | |
| Routines via Pi extension `/work/.pi/extensions/routines.ts` | |

Self-addendum: `/work/.pi/SYSTEM.md` (Pi identity; legacy `.opencode/SYSTEM.md` is not loaded).  
Self-extensions: `/work/.pi/extensions/*.ts` (`pi.registerTool`).
Instruction skills: `/work/.pi/skills/<name>/SKILL.md`; enabled Markdown is injected by precedence workspace, user (`/data/pi/skills`), bundled (`/opt/pi/skills`). Markdown edits apply next turn without gateway reload. Generated skills land only after proposal review.

Provider keys: supervisor writes Pi auth to `/data/pi/agent/auth.json` (`{ type: "api_key", key }`); Google also sets `GEMINI_API_KEY`. Logical session ids persist in `/data/pi/gateway-sessions.json` across gateway restarts.

---

## Architecture

**Compose (`docker-compose.yml`)** defines only the **bot** on network `punch-nightly_edge` (compose key `edge`).

- **bot** (`docker/bot.Dockerfile`) — Discord client (`DISCORD_TOKEN`). Forwards chat to each user's **Pi gateway** over HTTP. Runs durable routine scheduler and bot HTTP **`:4098`**. **Docker socket** mounted read-only; **`/Punch Nightly:/punch:ro`** so `sandbox-manager` can build the sandbox image.
- **sandbox** (`docker/sandbox.Dockerfile`) — **not** in compose. Created via `/sandbox create` → builds **`punch-nightly-sandbox:latest`**, runs `punch-nightly_sandbox-<name>_1` with alias **`sandbox-<name>`**. Image installs `@earendil-works/pi-coding-agent` and Tailscale; supervisor runs `pi-gateway` on `:4096` and API on `:4097`.

**Request flow:** Discord → `src/index.js` → `src/agent.js` → `http://sandbox-<name>:4096` (pi-gateway) → `pi --mode rpc`.

**Routing:** `SANDBOX_MAP` + `/data/sandbox_users.json` → `serverFor(userId)`. Empty default sandbox URL env is intentional (dynamic registry only).

## Codebase layout

| Path | Role |
|------|------|
| `src/index.js` | Discord client, chat queue, bot HTTP `:4098` |
| `src/agent.js` | Pi HTTP client (via pi-gateway), `BASE_SYSTEM`, compress |
| `src/memory.js` | Selective cited memory retrieval, durable facts, DM-only daily notes, compaction |
| `src/doctor/index.js` | Bot-side routing, Docker, scheduler, and report diagnostics |
| `docker/doctor.mjs` | Sandbox-local Pi, provider, browser, Tailscale, storage, and security probes |
| `docker/pi-gateway.mjs` | Internal HTTP `:4096` adapter over Pi RPC |
| `docker/serve-supervisor.mjs` | Gateway child + `:4097` supervisor API |
| `docker/routines_extension.ts` | Seed Pi routines tool |
| `docker/skills-manager.mjs` | Instruction-skill metadata, precedence, proposals, enable state |
| `docker/worker-manager.mjs` | Isolated Pi worker process records/lifecycle |
| `docker/pi-worker-runner.mjs` | Single worker Pi RPC runner with tool allowlist |
| `docker/sandbox.Dockerfile` | Pi sandbox image |
| `docker-compose.yml` | Bot only; `name: punch-nightly` |

## Supervisor API (sandbox `:4097`)

Includes `/skills`, `/workers`, plus `/env`, `/secrets`, `/model`, `/apikey`, `/tools`, `/mcp` (unused registry; Discord `/mcp` says not supported yet), `/pigeon`, `/tasks`, `/tailscale/*`, `/doctor`, `/doctor/fix`.

## Known quirks

- Sandboxes from older agent images must be **recreated** to get the Pi image.
- Provider keys via `/apikey` or `/env` (e.g. `ANTHROPIC_API_KEY`) — no free bundled provider path.
- **`/compress`** uses `OPENCODE_COMPRESS_TIMEOUT` (default 300s; legacy env name).
- **Prod vs nightly:** never `docker compose` in `/punch` when user means nightly, and vice versa.

## Env naming (legacy aliases)

Compose and sandboxes still use `OPENCODE_*` variable names (`OPENCODE_SERVER_PASSWORD`, `OPENCODE_MODEL`, etc.) as **legacy aliases** so existing `.env` / containers keep working. Product copy and Discord should not say “OpenCode”; treat them as Punch/Pi stack secrets. Basic-auth username remains `opencode` for wire compatibility.

## Security

Unregistered Discord users cannot reach any sandbox. Bot has Docker socket only for dynamic sandboxes.
