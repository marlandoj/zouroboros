#!/bin/bash
# Remote deploy of hetzner-exec MCP server on the Zouroboros Annex box.
# Expects: /tmp/hetzner-exec-deploy.tgz present, HETZNER_EXEC_TOKEN in env.
set -euo pipefail

APP_DIR=/opt/hetzner-exec
ENV_DIR=/etc/hetzner-exec

echo "[deploy] cloud-init + docker sanity"
docker --version
docker compose version || true

echo "[deploy] unpack source into $APP_DIR"
mkdir -p "$APP_DIR"
tar xzf /tmp/hetzner-exec-deploy.tgz -C "$APP_DIR"
ls -la "$APP_DIR"

echo "[deploy] create service user 'mcp' (docker group) if missing"
id -u mcp >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" mcp
usermod -aG docker mcp

echo "[deploy] write $ENV_DIR/env"
mkdir -p "$ENV_DIR"
cat > "$ENV_DIR/env" <<EOF
HETZNER_EXEC_TOKEN=${HETZNER_EXEC_TOKEN}
HETZNER_EXEC_PORT=6666
HETZNER_EXEC_SANDBOX_PROVIDER=docker
HETZNER_EXEC_DEFAULT_IMAGE=debian:12-slim
HETZNER_EXEC_DEFAULT_TIMEOUT_MS=30000
HETZNER_EXEC_MAX_TIMEOUT_MS=3600000
EOF
# systemd runs the unit as User=mcp Group=docker, so the primary group is
# `docker`, not `mcp` — a root:mcp 640 file is unreadable by the process and
# `docker run --env-file` fails with EACCES. Own it by the mcp user, 0600.
chown mcp:mcp "$ENV_DIR/env"
chmod 600 "$ENV_DIR/env"

echo "[deploy] build docker image hetzner-exec:0.1.0"
docker build -t hetzner-exec:0.1.0 "$APP_DIR"

echo "[deploy] install systemd unit"
cp "$APP_DIR/deploy/hetzner-exec.service" /etc/systemd/system/hetzner-exec.service
systemctl daemon-reload
systemctl enable --now hetzner-exec

echo "[deploy] wait for /healthz"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:6666/healthz" >/dev/null 2>&1; then
    echo "[deploy] healthz OK"; break
  fi
  echo "[deploy] waiting for server... ($i/20)"; sleep 2
done

echo "[deploy] systemd status"
systemctl --no-pager status hetzner-exec | head -15 || true
echo "[deploy] DONE"
