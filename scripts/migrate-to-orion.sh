#!/usr/bin/env bash
# Migrate the punch stack to another host (default: orion) over SSH.
#
# It is a CUTOVER, not a clone: the Discord token can only drive one live bot at
# a time (two stacks on the same token = double replies + gateway fights). So by
# default this stops the LOCAL stack before bringing up the remote one.
#
# Usage:
#   scripts/migrate-to-orion.sh                 # preflight + sync + cutover + up
#   REMOTE=orion DEST=punch ...                 # override target host / dir
#   MIGRATE_WORK=1 ...                          # also copy the sandbox_work volume
#                                               #   (the LLM's /work: built sites, apt state)
#   NO_CUTOVER=1 ...                            # DON'T stop local (only for a dry test host
#                                               #   with a DIFFERENT token — else double bot)
#   SYNC_ONLY=1 ...                             # stop after rsync (no remote build/up)
#
# Safe to read first: every destructive step is announced and the remote `up`
# is gated behind the cutover.
set -euo pipefail

REMOTE=${REMOTE:-orion}
DEST=${DEST:-punch}                         # remote path, relative to remote $HOME
SRC=$(cd "$(dirname "$0")/.." && pwd)       # local repo root
PROJECT=$(basename "$SRC")                  # compose project name = dir name
MIGRATE_WORK=${MIGRATE_WORK:-0}
NO_CUTOVER=${NO_CUTOVER:-0}
SYNC_ONLY=${SYNC_ONLY:-0}

log() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
die() { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Remote preflight (read-only; aborts on any blocker) -------------------
log "preflight: $REMOTE"
ssh "$REMOTE" 'bash -s' <<'EOF' || die "preflight failed on remote"
set -e
fail=0
command -v docker >/dev/null      || { echo "  ✗ docker missing"; fail=1; }
docker compose version >/dev/null 2>&1 || { echo "  ✗ docker compose v2 missing"; fail=1; }
[ -c /dev/net/tun ]               || { echo "  ✗ /dev/net/tun missing (TS_USERSPACE=false needs it)"; fail=1; }
[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ] || echo "  ! ip_forward=0 (Docker usually sets it on start)"
# The egress trap: host routing internet through an exit node blackholes ALL
# container traffic. Refuse to migrate into that.
if ip route get 1.1.1.1 2>/dev/null | grep -q tailscale0; then
  echo "  ✗ host routes internet via tailscale0 (exit node) — containers would have NO egress."
  echo "    fix: sudo tailscale set --exit-node= "
  echo "     or: sudo ip rule add from 172.21.0.0/16 lookup main pref 5260"
  fail=1
fi
systemctl is-active --quiet firewalld 2>/dev/null && echo "  ! firewalld active — verify egress after 'up' (postcheck does this)"
[ "$fail" = 0 ] && echo "  ✓ preflight OK"
exit $fail
EOF

# --- 2. Cutover: stop the local stack so only one bot holds the token ---------
if [ "$NO_CUTOVER" = 1 ]; then
  echo "NO_CUTOVER=1 → leaving local stack running (ensure the remote uses a DIFFERENT DISCORD_TOKEN)."
else
  log "cutover: stopping local stack ($PROJECT) to free the Discord token"
  ( cd "$SRC" && docker compose down )
fi

# --- 3. Sync the repo (source, Dockerfiles, compose, .env, secrets/) ----------
# Not a git repo, so we ship the whole tree. .env and secrets/ ARE included (they
# hold the tokens + the poolside/opencode auth.json the sandbox mounts).
log "sync $SRC/ -> $REMOTE:$DEST/"
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  "$SRC"/ "$REMOTE:$DEST"/

# --- 4. Optional: carry the sandbox_work volume (LLM's /work contents) --------
if [ "$MIGRATE_WORK" = 1 ]; then
  log "migrating ${PROJECT}_sandbox_work volume (/work: built sites, apt/pip state)"
  docker run --rm -v "${PROJECT}_sandbox_work":/from alpine tar -C /from -cf - . \
    | ssh "$REMOTE" "docker volume create ${DEST}_sandbox_work >/dev/null && \
        docker run --rm -i -v ${DEST}_sandbox_work:/to alpine tar -C /to -xf -"
fi

if [ "$SYNC_ONLY" = 1 ]; then
  log "SYNC_ONLY=1 → done (no remote build/up)"
  echo "Bring it up yourself: ssh $REMOTE 'cd $DEST && docker compose up --build -d'"
  exit 0
fi

# --- 5. Build + start on the remote -------------------------------------------
log "build + up on $REMOTE (first build pulls images + npm, takes a few min)"
ssh "$REMOTE" "cd $DEST && docker compose up --build -d"

# --- 6. Postcheck: egress (firewalld sanity) + a live poolside round-trip -----
log "postcheck (waiting for gateway + serve to settle)"
ssh "$REMOTE" "cd $DEST && sleep 12 && \
  echo '--- bot -> Discord egress ---' && \
  docker compose exec -T bot node -e 'fetch(\"https://discord.com/api/v10/gateway\",{signal:AbortSignal.timeout(8000)}).then(r=>console.log(\"discord\",r.status)).catch(e=>console.log(\"discord FAIL\",e.message))' && \
  echo '--- poolside round-trip ---' && \
  docker compose exec -T bot node -e 'import(\"./src/opencode.js\").then(m=>m.runOpencode(\"reply with exactly: ORION-OK\")).then(r=>console.log(JSON.stringify(r.text.slice(0,40)))).catch(e=>console.log(\"opencode FAIL\",e.message))' && \
  echo '--- bot log ---' && \
  docker compose logs --tail=5 bot"

log "done — punch is live on $REMOTE"
echo "If Discord shows the bot offline: check 'ssh $REMOTE \"cd $DEST && docker compose logs -f bot\"'"
echo "Remember: remove the stale 'punch-sandbox' node from the Tailscale admin if the old host is gone."
