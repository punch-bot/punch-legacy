FROM node:22-bookworm

ARG PI_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget ca-certificates openssh-client openssh-server \
      jq ripgrep fd-find tree less vim-tiny nano \
      python3 python3-pip python3-venv pipx \
      build-essential make gcc g++ pkg-config \
      iproute2 iputils-ping dnsutils netcat-openbsd \
      procps htop unzip zip tar file \
      libnss3 libatk-bridge2.0-0 libcups2 libxkbcommon0 libgtk-3-0 libasound2 libgbm-dev fonts-liberation xdg-utils \
      xvfb x11vnc fluxbox novnc websockify dbus-x11 \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg | gpg --dearmor -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list | tee /etc/apt/sources.list.d/tailscale.list \
    && apt-get update && apt-get install -y --no-install-recommends tailscale \
    && rm -rf /var/lib/apt/lists/*

# Pi coding agent (replaces opencode-ai). --ignore-scripts per Pi install docs.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
    && npm cache clean --force \
    && pi --version

ENV HOME=/root \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/opt/picfg \
    XDG_CACHE_HOME=/data/cache \
    XDG_STATE_HOME=/data/state \
    PI_CODING_AGENT_DIR=/data/pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/data/pi/sessions \
    DISPLAY=:99 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pi/playwright-browsers

RUN mkdir -p /data/pi/sessions /data/pi/agent /data/cache /data/state /work \
      /opt/pi/extensions /opt/pi/playwright-browsers /opt/picfg /work/.pi/extensions /work/.pi/tools /work/.pi/skills /data/pi/skills /data/pi/skill-proposals /data/workers \
      /root/.chrome-profile /work/screenshots /var/log

# Playwright + Chromium under /opt/pi (not /root — home is a runtime volume mount).
COPY docker/pi-package.json /opt/pi/package.json
RUN cd /opt/pi && npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY docker/serve-supervisor.mjs /usr/local/bin/serve-supervisor.mjs
COPY docker/doctor.mjs /usr/local/lib/doctor.mjs
COPY docker/pi-gateway.mjs /usr/local/bin/pi-gateway.mjs
COPY docker/pi-turn-completion.mjs /usr/local/lib/pi-turn-completion.mjs
COPY docker/pi-progress.mjs /usr/local/lib/pi-progress.mjs
COPY src/pigeon-peer.js /usr/local/lib/pigeon-peer.js
COPY docker/skills-manager.mjs /usr/local/lib/skills-manager.mjs
COPY docker/worker-manager.mjs /usr/local/lib/worker-manager.mjs
COPY docker/pi-worker-runner.mjs /usr/local/bin/pi-worker-runner.mjs
COPY docker/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
COPY docker/routines_extension.ts /opt/pi/extensions/routines.ts
COPY docker/collab_extension.ts /opt/pi/extensions/collab.ts
COPY docker/browser_extension.ts /opt/pi/extensions/browser.ts
COPY docker/searxng_extension.ts /opt/pi/extensions/searxng.ts
COPY docker/webfetch_extension.ts /opt/pi/extensions/webfetch.ts
COPY docker/report_progress_extension.ts /opt/pi/extensions/report_progress.ts
COPY docker/compress_context_extension.ts /opt/pi/extensions/compress_context.ts
COPY docker/context-pruning-state.mjs /opt/pi/context-pruning-state.mjs
COPY docker/pi-SYSTEM.md /opt/pi/SYSTEM.md
COPY docker/skills/ /opt/pi/skills/
# API keys for Pi come from supervisor /env and /apikey (provider env vars).
RUN echo '{}' > /opt/picfg/seed-auth.json
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

WORKDIR /work
EXPOSE 4096 4097 6080
CMD ["/usr/local/bin/sandbox-entrypoint.sh"]
