# Sandbox host: owns Docker. Builds the sandbox image, runs/removes/restarts
# per-user sandbox containers, serves git exec to the supervisor, and registers
# itself as a `kind: "sandbox"` host. Runs NO Discord and no model traffic.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io docker-compose && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production \
    HOME=/tmp \
    DATA_DIR=/state
RUN mkdir -p /state

CMD ["node", "src/sandbox-host/server.js"]
