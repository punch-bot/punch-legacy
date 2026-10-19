FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io docker-compose && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV HOME=/data \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    XDG_STATE_HOME=/data/state \
    DATA_DIR=/state \
    NODE_ENV=production
RUN mkdir -p /data/config /data/cache /data/state /state

CMD ["node", "src/index.js"]
