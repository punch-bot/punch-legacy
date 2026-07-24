Got it. Here's the final plan with all decisions locked in.

---

## Final Migration Plan: OpenCode → Pi for Punch

### Workstream 1: Tailscale Port

**Scope:** ~150 lines across 5 files

| File | Change |
|------|--------|
| `docker/sandbox.Dockerfile` | Add Tailscale apt repo + install |
| `docker/sandbox-entrypoint.sh` | Start `tailscaled`, `tailscale set --accept-dns=false` |
| `docker/serve-supervisor.mjs` | Add `/tailscale/key`, `/tailscale/login`, `/tailscale/status`, `/tailscale/down` routes + auto-connect IIFE |
| `src/sandbox-manager.js` | Add `ts_state_<name>` volume, `--device /dev/net/tun`, `--cap-add NET_ADMIN` |
| `src/index.js` | Add `/tailscale` slash command (key, login, reauth, status, down) |

Port directly from production — same flags, same volume structure, same `--accept-dns=false` everywhere.

---

### Workstream 2: Composio via Pi Extension

**Scope:** ~250 lines across 6 files

| File | Change |
|------|--------|
| `docker/composio_extension.ts` | **New** — 6 meta-tools via `@composio/core`, reads `SANDBOX_USER_ID` + `COMPOSIO_API_KEY` from env, creates session per `session_start` |
| `docker/pi-package.json` | Add `@composio/core` dependency |
| `docker/sandbox.Dockerfile` | COPY composio extension to `/opt/pi/extensions/composio.ts` |
| `src/index.js` | Add `/link` slash command (app, status, disconnect) — calls supervisor HTTP API, not bot-side SDK |
| `src/agent.js` | Add COMPOSIO section to `BASE_SYSTEM` |
| `sandbox_init/mcp.json` | Remove stale composio MCP entry |

**`/link` flow:**
1. User runs `/link app gmail`
2. Bot resolves sandbox via `apiUrlFor(userId)`
3. Bot sends `POST <sandbox>:4097/composio/connect` (new supervisor route) with `{ toolkits: ["gmail"] }`
4. Supervisor calls the composio extension's connect logic (or the extension exposes this via a helper endpoint)
5. OAuth URL returned to bot, bot DMs it to user
6. User clicks, authorizes
7. Bot optionally polls for connection completion

Actually — since the extension runs inside Pi (not as an HTTP server), the `/link` flow needs reconsideration. The cleanest approach:

**Revised `/link` flow:**
1. User runs `/link app gmail`
2. Bot sends a message to the sandbox: "Please run composio_connect to link Gmail"
3. Model calls `composio_connect({ toolkits: ["gmail"] })`
4. Extension returns OAuth URL as text
5. Model relays URL to user in Discord
6. User clicks, authorizes

This is the natural flow — the model handles it. The `/link` command just triggers the model to do it, providing a more discoverable UX than typing "connect my Gmail".

**Even simpler alternative:** Skip the supervisor HTTP route entirely. `/link` just sends a prompt to the sandbox like `/compress` does — the model calls `composio_connect`, and the result flows back naturally. The command is purely a UX convenience.

---

### Workstream 3: Free Provider via OpenCode Zen

**Scope:** ~50 lines across 2 files

| File | Change |
|------|--------|
| `docker/serve-supervisor.mjs` | Add `opencode` provider to `models.json` generation, add `"opencode": "OPENCODE_API_KEY"` to `PROVIDER_ENV_MAP` |
| `src/agent.js` | Add note about free models to BASE_SYSTEM |

**Default model change:** `OPENCODE_DEFAULT_MODEL` becomes `opencode/big-pickle` (free) instead of `anthropic/claude-sonnet-4-5`. Users can switch via `/models`.

**models.json provider config:**
```json
{
  "opencode": {
    "api": "openai",
    "baseUrl": "https://opencode.ai/zen/v1",
    "models": {
      "big-pickle": { "name": "Big Pickle (Free)", "context": 128000, "maxTokens": 8192 },
      "deepseek-v4-flash-free": { "name": "DeepSeek V4 Flash Free", "context": 128000, "maxTokens": 8192 },
      "mimo-v2.5-free": { "name": "MiMo-V2.5 Free", "context": 128000, "maxTokens": 8192 },
      "laguna-s-2.1-free": { "name": "Laguna S 2.1 Free", "context": 128000, "maxTokens": 8192 },
      "north-mini-code-free": { "name": "North Mini Code Free", "context": 128000, "maxTokens": 8192 },
      "nemotron-3-ultra-free": { "name": "Nemotron 3 Ultra Free", "context": 128000, "maxTokens": 8192 }
    }
  }
}
```

---

### Execution Order

1. **Free provider** — smallest, no dependencies, immediate value
2. **Tailscale** — infrastructure, unlocks browser for Composio
3. **Composio** — depends on Tailscale for OAuth browser flows

### Summary of All Changes

| File | Workstream | Lines |
|------|-----------|-------|
| `docker/sandbox.Dockerfile` | Tailscale, Composio | ~15 |
| `docker/sandbox-entrypoint.sh` | Tailscale | ~5 |
| `docker/serve-supervisor.mjs` | Tailscale, Free provider | ~80 |
| `src/sandbox-manager.js` | Tailscale | ~10 |
| `src/index.js` | Tailscale, Composio | ~80 |
| `docker/composio_extension.ts` | Composio (new) | ~200 |
| `docker/pi-package.json` | Composio | ~1 |
| `src/agent.js` | Composio, Free provider | ~20 |
| `sandbox_init/mcp.json` | Composio (cleanup) | -3 |

**Total:** ~400 lines of new/modified code across 9 files.

Ready to start implementing whenever you are.