#!/bin/bash
set -e

# Start Xvfb for headful browser (Puppeteer Pi extension + noVNC)
Xvfb :99 -screen 0 1280x800x24 > /var/log/xvfb.log 2>&1 &

# Start fluxbox window manager
fluxbox >/dev/null 2>&1 &

# Start noVNC if VNC_PASSWORD is set
if [ -n "$VNC_PASSWORD" ]; then
  x11vnc -display :99 -passwd "$VNC_PASSWORD" -forever -shared -o /var/log/x11vnc.log >/dev/null 2>&1 &
  # websockify authenticates at the VNC layer (x11vnc holds the password), so we
  # do NOT pass --passwd here — newer websockify dropped that flag and would exit.
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
fi

# Start Tailscale without replacing Docker's internal DNS.
mkdir -p /var/run/tailscale /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
tailscale set --accept-dns=false 2>/dev/null || true

# Seed Pi extensions into the writable work volume (self-extension reload).
# routines.ts preserves user edits; the rest refresh from the image each start.
mkdir -p /work/.pi/extensions
for ext in routines collab browser searxng webfetch report_progress compress_context; do
  [ -f "/opt/pi/extensions/$ext.ts" ] || continue
  if [ "$ext" = "routines" ] && [ -f "/work/.pi/extensions/routines.ts" ]; then
    continue
  fi
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
# Seed Pi identity addendum (always refresh so persona stays Pi-only)
if [ -f /opt/pi/SYSTEM.md ]; then
  cp /opt/pi/SYSTEM.md /work/.pi/SYSTEM.md
fi

# Start sshd
mkdir -p /run/sshd
ssh-keygen -A 2>/dev/null || true
/usr/sbin/sshd

# Start supervisor (API :4097 + pi-gateway :4096)
exec node /usr/local/bin/serve-supervisor.mjs "${PI_MODEL:-${OPENCODE_MODEL:-opencode/big-pickle}}"
