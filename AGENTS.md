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
| `/reset` (new session), `/compress` (Pi `compact`) | MCP OAuth (`/mcp auth` / `logout`) — use headers/env tokens for now |
| `/models`, `/env`, `/apikey`, `/secrets`, `/tailscale`, `/doctor`, `/memory`, `/skills`, `/workers`, `/multitask` | Legacy `/work/.opencode/tools` (not loaded; only `/work/.pi/extensions` reload) |
| Built-in Pi tools: bash, read, write, edit; isolated worker Pi processes | Full multi-session concurrency for main chat gateway (it switches logical sessions) |
| **Browser** via Pi extension `browser.ts` (`puppeteer_*` tools; screenshots auto-attach to Discord) | Third-party serve shims not used |
| Progress SSE → Discord thinking UI | |
| Routines via Pi extension `/work/.pi/extensions/routines.ts` | |
| **MCP** via `pi-mcp-adapter` + Discord `/mcp` list/add/remove (`mcp` proxy tool) | |

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

Includes `/skills`, `/workers`, `/workers/settings`, plus `/env`, `/secrets`, `/model`, `/apikey`, `/tools`, `/mcp` (registry + Pi reload via pi-mcp-adapter), `/pigeon`, `/tasks`, `/tailscale/*`, `/doctor`, `/doctor/fix`.

## Active Context Pruning (PNCH-6)

Three-part memory management system:

1. **Selective Pi pruning tools** (`/opt/pi/extensions/compress_context.ts`) — `compress_context` replaces stale complete user-turn ranges with model-written summaries in provider context. Blocks have stable Pi entry IDs, preserve raw session entries, and can be searched (`search_context`), inspected (`context_status`), and restored (`decompress_context`). First user message is protected; uncertain mappings leave raw context intact.

2. **Context-pruning threshold** — `/botmode auto-compress` sets per-user threshold (default 75%, configurable 50-75%, or 0 to disable). Next Pi turn receives a selective-pruning nudge when usage reaches it. It does not destructively compact the whole session.

3. **`/work/.punch-memory.md`** — persistent project memory file inside each sandbox. Punch injects a bounded copy at every turn; model updates architecture decisions, conventions, gotchas, and preferences before pruning. Survives session resets and compactions.

**Flow:** threshold nudge or model detects context pressure → model saves durable facts to `.punch-memory.md` → model calls `compress_context` with visible user-message boundaries and self-contained summary → Pi context hook replaces only that range. `/compress` remains explicit whole-session emergency fallback.

## Known quirks

- Sandboxes from older agent images must be **recreated** to get the Pi image.
- Provider keys via `/apikey` or `/env` (e.g. `ANTHROPIC_API_KEY`) — no free bundled provider path.
- **`/compress`** uses `OPENCODE_COMPRESS_TIMEOUT` (default 300s; legacy env name).
- **Prod vs nightly:** never `docker compose` in `/punch` when user means nightly, and vice versa.

## Env naming (legacy aliases)

Compose and sandboxes still use `OPENCODE_*` variable names (`OPENCODE_SERVER_PASSWORD`, `OPENCODE_MODEL`, etc.) as **legacy aliases** so existing `.env` / containers keep working. Product copy and Discord should not say “OpenCode”; treat them as Punch/Pi stack secrets. Basic-auth username remains `opencode` for wire compatibility.

## Security

Unregistered Discord users cannot reach any sandbox. Bot has Docker socket only for dynamic sandboxes.

## Cursor Cloud specific instructions

Startup automation runs `npm install` only (bot deps for local dev + `npm test`). Everything below is manual/non-obvious.

**Node vs Docker paths.** Editing `src/` and running `npm test` (`node --test test/*.mjs`, 28 tests) needs no Docker. Actually *running* the product needs Docker (bot + per-user sandbox images). Standard commands live in `README.md` / `NIGHTLY.md` / the top of this file — don't duplicate them.

**Docker daemon is not auto-started.** Docker Engine is installed in the VM image but `dockerd` does not run on a fresh pod. Start it and open the socket each session:

```sh
sudo nohup dockerd > /tmp/dockerd.log 2>&1 &   # wait ~8s
sudo chmod 666 /var/run/docker.sock            # re-run after any dockerd restart
```

Daemon config (`/etc/docker/daemon.json`) uses `fuse-overlayfs` with `features.containerd-snapshotter: false` (required for fuse-overlayfs on Docker 29 in this Firecracker VM).

**cgroup v2 threaded-mode caveat (important).** The VM's root cgroup is `domain threaded`, so the memory/io domain controllers can't be delegated. Containers launched the way the bot does it — default (private) cgroup namespace **with** `--memory`/`--cpus`/`--pids-limit` (see `src/sandbox-manager.js` `composeUp`) — fail with:
`cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode`.
Workaround: run sandbox containers with **`--cgroupns=host`** (resource limits then don't apply). This is a VM infra limitation, not a repo bug — do not "fix" it by editing `sandbox-manager.js`. Consequence: the bot's `/sandbox create` will hit this error in this VM as-is; to demo Pi, run the sandbox image directly with `--cgroupns=host`.

Manually run the sandbox (Pi) stack to verify it end-to-end:

```sh
docker network create punch-nightly_edge 2>/dev/null || true
docker run -d --cgroupns=host --name punch-nightly_sandbox-hello_1 \
  --network punch-nightly_edge --network-alias sandbox-hello \
  -e OPENCODE_SERVER_PASSWORD=devpassword -e SANDBOX_NAME=hello \
  -e SANDBOX_USER_ID=000000000000000000 -e PUNCH_DOCTOR_TOKEN=doctortoken \
  -p 4096:4096 -p 4097:4097 --device /dev/net/tun --cap-add NET_ADMIN \
  punch-nightly-sandbox:latest
# gateway health (basic auth opencode:$OPENCODE_SERVER_PASSWORD):
curl -su opencode:devpassword http://localhost:4096/health   # {"ok":true,"tools":[...]}
```

**`.env` is gitignored and required** for `docker compose` (`env_file: .env`). Create it from `.env.example` and set `DISCORD_TOKEN`; use Nightly identity (`PUNCH_STACK_NAME=punch-nightly`, `PUNCH_BOT_PORT=4099`, `PUNCH_HOST_SOURCE=/workspace`).

**Secrets needed for full end-to-end (not present in the VM):**
- `DISCORD_TOKEN` — the bot exits immediately without it (`src/index.js`), so no Discord flow runs.
- `POOLSIDE_API_KEY` — the provider used for tests here. A Pi turn reaches `pi --mode rpc` and fails with `No API key found for poolside` until set. Poolside is a built-in OpenAI-compatible provider seeded by the supervisor (`docker/serve-supervisor.mjs`, baseUrl `https://inference.poolside.ai/v1`); Pi resolves its key from the `POOLSIDE_API_KEY` env var. Run the sandbox with `OPENCODE_MODEL=poolside/poolside/laguna-m.1` (splits to `--provider poolside --model poolside/laguna-m.1`) and pass `POOLSIDE_API_KEY` into the container env, or set it via supervisor `/apikey`/`/env` (Discord `/apikey set poolside <key>`). Note `anthropic/claude-sonnet-4-5` is only an alias to the default `opencode/big-pickle`. There is no free bundled provider.
