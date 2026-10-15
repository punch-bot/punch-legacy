#!/bin/bash
set -e

# Start Tailscale without replacing Docker's internal DNS.
mkdir -p /var/run/tailscale /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
tailscale set --accept-dns=false 2>/dev/null || true

# The Punch runtime bundles these tools. Archive the old copies, including user
# edits, before Pi discovers extensions in the persisted work volume.
node /usr/local/lib/pi-runtime-migration.mjs

# SearXNG remains a sandbox extension; refresh its image copy each start.
mkdir -p /work/.pi/extensions
cp /opt/pi/extensions/searxng.ts /work/.pi/extensions/searxng.ts
# Seed .punch-memory.md if it doesn't exist
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
# Seed Pi identity addendum (always refresh so persona stays Pi-only)
if [ -f /opt/pi/SYSTEM.md ]; then
  cp /opt/pi/SYSTEM.md /work/.pi/SYSTEM.md
fi

# Start sshd
mkdir -p /run/sshd
ssh-keygen -A 2>/dev/null || true
/usr/sbin/sshd

# Start supervisor (API :4097 + pi-gateway :4096)
exec node /usr/local/bin/serve-supervisor.mjs "${PI_MODEL:-opencode/big-pickle}"
