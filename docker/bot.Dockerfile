# The Discord bot: a thin Pi *client*. Holds DISCORD_TOKEN. Runs NO user
# commands itself — it forwards each message to the sandbox's Pi gateway
# over HTTP, so all tool execution happens in the sandbox container.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim
# The bot speaks to the sandbox purely over HTTP (node's global fetch) — no
# Pi CLI needed on the bot host. Docker CLI is needed for dynamic sandbox management.
RUN apt-get update && apt-get install -y --no-install-recommends docker.io docker-compose && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Writable state for the bot: client scratch (HOME) + memory dir.
ENV HOME=/data \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    XDG_STATE_HOME=/data/state \
    DATA_DIR=/state \
    NODE_ENV=production
RUN mkdir -p /data/config /data/cache /data/state /state

CMD ["node", "src/index.js"]
