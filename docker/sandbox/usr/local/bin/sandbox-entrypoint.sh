#!/bin/bash
set -e

# Start Tailscale without replacing Docker's internal DNS.
mkdir -p /var/run/tailscale /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
tailscale set --accept-dns=false 2>/dev/null || true

# Seed Pi extensions into the writable work volume (self-extension reload).
# Pi core ships browser, webfetch, report_progress, context-pruning, routines,
# collab and todos as built-ins, so only the SearXNG websearch shim is seeded.
# Drop stale copies of the now built-in extensions left in the work volume.
mkdir -p /work/.pi/extensions
for stale in browser webfetch report_progress compress_context routines collab; do
  rm -f "/work/.pi/extensions/$stale.ts"
done
for ext in searxng; do
  [ -f "/opt/pi/extensions/$ext.ts" ] || continue
  cp "/opt/pi/extensions/$ext.ts" "/work/.pi/extensions/$ext.ts"
done
if [ -f /opt/pi/context-pruning-state.mjs ]; then
  cp /opt/pi/context-pruning-state.mjs /work/.pi/context-pruning-state.mjs
fi
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
# Seed Pi identity addendum (punch system prompt; runAgent reads it from /work/.pi/SYSTEM.md)
if [ -f /opt/pi/SYSTEM.md ]; then
  cp /opt/pi/SYSTEM.md /work/.pi/SYSTEM.md
fi

# Start sshd
mkdir -p /run/sshd
ssh-keygen -A 2>/dev/null || true
/usr/sbin/sshd

# Start supervisor (API :4097 + pi-gateway :4096)
exec node /usr/local/bin/serve-supervisor.mjs "${PI_MODEL:-${OPENCODE_MODEL:-opencode/big-pickle}}"
