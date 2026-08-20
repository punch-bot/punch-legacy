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

# Playwright + Chromium under /opt/pi (not /root — home is a runtime volume mount).
# docker/sandbox/ holds the sandbox filesystem tree (incl. package.json), copied
# before the Pi deps install; runtime dirs are created by the entrypoint/supervisor.
COPY docker/sandbox/ /
RUN cd /opt/pi && npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

# pigeon-peer.js stays single-source in src/ (shared with the bot).
COPY src/pigeon-peer.js /usr/local/lib/pigeon-peer.js
# API keys for Pi come from supervisor /env and /apikey (provider env vars).
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

WORKDIR /work
EXPOSE 4096 4097 6080
CMD ["/usr/local/bin/sandbox-entrypoint.sh"]
