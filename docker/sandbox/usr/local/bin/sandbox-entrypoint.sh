#!/bin/bash
set -e

mkdir -p /var/run/tailscale /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
tailscale set --accept-dns=false 2>/dev/null || true

node /usr/local/lib/pi-runtime-migration.mjs

mkdir -p /work/.pi/extensions
cp /opt/pi/extensions/searxng.ts /work/.pi/extensions/searxng.ts
cp /opt/pi/extensions/memory-recall.ts /work/.pi/extensions/memory-recall.ts
if [ ! -f /work/.punch-memory.md ]; then
  cat > /work/.punch-memory.md << 'PUNCH_MEMORY_EOF'
# Project memory

Persistent project context that survives session resets and compactions.
Update sections with the `update_memory` tool.

## Guidelines
- architecture decisions
- code conventions
- project gotchas

## Open work
- current task
- next steps
PUNCH_MEMORY_EOF
fi
if [ -f /opt/pi/SYSTEM.md ]; then
  cp /opt/pi/SYSTEM.md /work/.pi/SYSTEM.md
fi

mkdir -p /run/sshd
ssh-keygen -A 2>/dev/null || true
/usr/sbin/sshd

exec node /usr/local/bin/serve-supervisor.mjs "${PI_MODEL:-opencode/big-pickle}"
