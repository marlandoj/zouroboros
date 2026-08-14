# syntax=docker/dockerfile:1
# hetzner-exec MCP server — remote command execution bridge for the Hetzner Compute Annex.
#
# Runtime: Bun (the server also runs on Node 18+). Zero external dependencies:
# it uses only node:* APIs + the platform `fetch`. No `bun install` step needed.
FROM oven/bun:1.2-debian AS base

WORKDIR /app

# Install the Docker CLI so `docker_image` / `sandbox=true` (docker provider) can
# drive the host daemon via the mounted /var/run/docker.sock (docker-outside-of-docker).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

# Copy only what is needed to run the server.
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# No JS dependencies to install (zero-dep). `bun install` would be a no-op.

# Default port — matches the UFW rule from ZOU-414 cloud-init (6666/tcp).
ENV HETZNER_EXEC_PORT=6666

EXPOSE 6666

# /healthz requires no auth — safe for a liveness probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.HETZNER_EXEC_PORT||'6666')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Refuse to boot without a token (the server fails closed if HETZNER_EXEC_TOKEN is unset).
CMD ["bun", "src/main.ts"]
