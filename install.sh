#!/usr/bin/env bash
# Punch — install & setup.
#
# Punch is a Discord bot fronting per-user Docker sandboxes that run Pi. This
# script takes a fresh machine (or fresh clone) to a running stack:
#
#   1. preflight: docker + compose v2 (+ /dev/net/tun for Tailscale)
#   2. checkout:  clones punch-bot/punch if the script is run standalone
#   3. config:    generates .env (Discord token, shared password, model)
#   4. start:     docker compose up --build -d
#   5. verify:    waits for the bot to connect to Discord
#
# Usage:
#   ./install.sh                     # interactive setup
#   ./install.sh --yes --token T     # non-interactive (password auto-generated)
#   ./install.sh --down              # stop the stack
#   ./install.sh --logs              # follow bot logs
#   ./install.sh --update            # git pull + rebuild
#   curl -fsSL <raw-url>/install.sh | bash -s -- --yes --token T
#
# Flags:
#   --token <t>       Discord bot token (required unless .env already has one)
#   --password <p>    shared bot/sandbox secret (default: generated)
#   --model <m>       default provider/model (default: anthropic/claude-sonnet-4-5)
#   --dir <path>      install dir when run standalone (default: ~/punch)
#   --port <n>        host port for the bot HTTP API (default: 4098)
#   --reconfigure     rewrite .env even if it exists
#   --no-start        write .env, skip docker compose up
#   -y, --yes         never prompt; fail instead of asking
#   -h, --help        this text
set -euo pipefail

REPO_URL="https://github.com/punch-bot/punch.git"
DEFAULT_MODEL="anthropic/claude-sonnet-4-5"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
log()  { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

usage() { awk 'NR>1 && /^#/{sub(/^# ?/, ""); print; next} NR>1{exit}' "$0"; }

# --- args -------------------------------------------------------------------
TOKEN=""
PASSWORD=""
MODEL="$DEFAULT_MODEL"
INSTALL_DIR="${PUNCH_DIR:-$HOME/punch}"
BOT_PORT="4098"
YES=0
RECONFIGURE=0
NO_START=0
ACTION="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --token)       TOKEN=$2; shift 2 ;;
    --password)    PASSWORD=$2; shift 2 ;;
    --model)       MODEL=$2; shift 2 ;;
    --dir)         INSTALL_DIR=$2; shift 2 ;;
    --port)        BOT_PORT=$2; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --no-start)    NO_START=1; shift ;;
    -y|--yes)      YES=1; shift ;;
    --down)        ACTION="down"; shift ;;
    --logs)        ACTION="logs"; shift ;;
    --update)      ACTION="update"; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown flag: $1 (try --help)" ;;
  esac
done

ask() {
  # ask <var> <prompt> [default] — skips when YES=1, applies default then
  local var=$1 prompt=$2 default=${3:-}
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  local input
  read -r -p "  $prompt ${default:+[$default]}: " input
  printf -v "$var" '%s' "${input:-$default}"
}

rand_password() {
  if command -v openssl >/dev/null; then
    openssl rand -hex 24
  else
    tr -dc 'a-f0-9' < /dev/urandom | head -c 48
  fi
}

# --- locate repo ------------------------------------------------------------
# When invoked as ./install.sh inside a clone, work there. When piped or run
# outside the repo, clone into INSTALL_DIR first.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/docker/bot.Dockerfile" ]; then
  ROOT="$SCRIPT_DIR"
else
  ROOT=""
fi

# --- actions that only need the checkout ------------------------------------
if [ "$ACTION" = "down" ] || [ "$ACTION" = "logs" ]; then
  [ -n "$ROOT" ] || { [ -f "$INSTALL_DIR/docker/bot.Dockerfile" ] && ROOT="$INSTALL_DIR"; }
  [ -n "$ROOT" ] || die "no punch checkout found (looked in $INSTALL_DIR)"
  cd "$ROOT"
  if [ "$ACTION" = "down" ]; then
    docker compose down
    ok "stack stopped (volumes kept; add --volumes to 'docker compose down' to wipe state)"
  else
    docker compose logs -f bot
  fi
  exit 0
fi

# --- preflight ----------------------------------------------------------------
log "preflight"
fail=0
command -v docker >/dev/null || { warn "docker missing — install Docker Engine: https://docs.docker.com/engine/install"; fail=1; }
if command -v docker >/dev/null; then
  docker compose version >/dev/null 2>&1 || { warn "docker compose v2 missing"; fail=1; }
  if docker info >/dev/null 2>&1; then
    :
  elif [ "$NO_START" = 1 ]; then
    warn "docker daemon not reachable — fine for --no-start, needed before compose up"
  else
    warn "docker daemon not reachable (start dockerd or fix permissions)"; fail=1
  fi
fi
[ "$fail" = 0 ] || die "fix the items above and re-run"
ok "docker + compose v2"

if [ -c /dev/net/tun ]; then
  ok "/dev/net/tun (per-sandbox Tailscale available)"
else
  warn "/dev/net/tun missing — sandboxes won't be able to use kernel Tailscale (TS_USERSPACE fallback applies)"
fi

# --- checkout -----------------------------------------------------------------
if [ -z "$ROOT" ]; then
  log "checkout"
  command -v git >/dev/null || die "git missing — needed to clone $REPO_URL"
  if [ -f "$INSTALL_DIR/docker-compose.yml" ] && [ -f "$INSTALL_DIR/docker/bot.Dockerfile" ]; then
    ROOT="$INSTALL_DIR"
    ok "existing checkout at $ROOT"
  else
    info "cloning punch-bot/punch → $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    ROOT="$INSTALL_DIR"
  fi
fi
cd "$ROOT"
ok "working dir: $ROOT"

if [ "$ACTION" = "update" ]; then
  log "update"
  git pull --ff-only
  docker compose up --build -d
  ok "updated and restarted"
  exit 0
fi

# --- .env ---------------------------------------------------------------------
log "config"
if [ -f .env ] && [ "$RECONFIGURE" = 0 ]; then
  ok ".env exists — keeping it (--reconfigure to rewrite)"
  # shellcheck disable=SC1091
  TOKEN="${TOKEN:-$(grep -E '^DISCORD_TOKEN=' .env | head -1 | cut -d= -f2-)}"
  PASSWORD="${PASSWORD:-$(grep -E '^PI_SERVER_PASSWORD=' .env | head -1 | cut -d= -f2-)}"
else
  [ -f .env ] && { cp .env ".env.bak.$(date +%s)"; warn "existing .env backed up"; }

  ask TOKEN "Discord bot token (Developer Portal → Bot; enable Message Content intent)" "$TOKEN"
  [ -n "$TOKEN" ] || die "DISCORD_TOKEN is required (pass --token or run interactively)"

  ask PASSWORD "Shared sandbox password" "$(rand_password)"
  ask MODEL "Default model (provider/model)" "$MODEL"

  VNC_PW=""
  ask VNC_PW "noVNC password for sandbox browser view (empty = off)" ""

  cp .env.example .env

  # upsert a KEY=value line into .env (values are token-safe; | and & escaped)
  env_set() {
    local key=$1 val=$2 esc
    esc=$(printf '%s' "$val" | sed 's/[&|\\]/\\&/g')
    if grep -q "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${esc}|" .env
    else
      printf '%s=%s\n' "$key" "$val" >> .env
    fi
  }

  env_set DISCORD_TOKEN "$TOKEN"
  env_set PI_SERVER_PASSWORD "$PASSWORD"
  env_set PI_MODEL "$MODEL"
  [ -n "$VNC_PW" ] && env_set VNC_PASSWORD "$VNC_PW"
  # The bot container mounts the repo read-only at /punch to build sandbox images.
  env_set PUNCH_HOST_SOURCE "$ROOT"
  env_set PUNCH_BOT_PORT "$BOT_PORT"
  ok ".env written"
fi

if [ "$NO_START" = 1 ]; then
  log "done (not started)"
  info "start later with: cd $ROOT && docker compose up --build -d"
  exit 0
fi

# --- start ----------------------------------------------------------------------
log "start"
docker compose up --build -d

log "verify"
deadline=$((SECONDS + 120))
online=""
while [ $SECONDS -lt $deadline ]; do
  if docker compose logs bot 2>/dev/null | grep -q "punch online as"; then
    online=$(docker compose logs bot 2>/dev/null | grep "punch online as" | tail -1 | sed 's/.*punch online as //')
    break
  fi
  if ! docker compose ps --status running bot 2>/dev/null | grep -q bot; then
    warn "bot container exited — recent logs:"
    docker compose logs --tail 20 bot || true
    die "bot failed to start (usually a bad DISCORD_TOKEN)"
  fi
  sleep 3
done

if [ -n "$online" ]; then
  ok "bot online as $online"
else
  warn "no 'punch online' log yet — check: docker compose logs -f bot"
fi

# --- done -----------------------------------------------------------------------
log "next steps (in Discord)"

# Discord bot tokens are base64(client_id).<ts>.<hmac> — recover the invite URL.
CLIENT_ID=""
if [ -n "$TOKEN" ]; then
  seg=$(printf '%s' "$TOKEN" | cut -d. -f1)
  pad=$(( (4 - ${#seg} % 4) % 4 ))
  CLIENT_ID=$(printf '%s%*s' "$seg" "$pad" '' | tr ' ' '=' | base64 -d 2>/dev/null || true)
fi
if [ -n "$CLIENT_ID" ]; then
  info "invite the bot to a server (slash commands):"
  info "  https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=0&scope=bot%20applications.commands"
fi
cat <<EOF

  1. /sandbox create <name> <your_discord_user_id>   # builds sandbox image on first run (slow)
  2. /apikey set anthropic <key>                     # or another provider (/env works too)
  3. mention the bot, or text it after /pair

  bot API:   http://localhost:${BOT_PORT}  (basic auth pi:\$PI_SERVER_PASSWORD)
  teardown:  ./install.sh --down     logs: ./install.sh --logs     update: ./install.sh --update
EOF
