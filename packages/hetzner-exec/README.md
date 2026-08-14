# hetzner-exec — Hetzner Compute Annex MCP server

Remote command-execution bridge for the Zouroboros Software Factory. Zo dispatches
tasks to this server; it runs a shell command (optionally inside a fresh Docker
container, or inside a fresh isolated sandbox) and returns the captured result.

> **Program:** Hetzner Compute Annex — sibling of ZOU-414 (box provisioning).
> This package is the MCP server that runs *on* the box ZOU-414 provisions.

## Contract

`POST /run` (bearer auth) — request body:

```jsonc
{
  "command": "docker compose up --abort-on-container-exit", // required, non-empty
  "docker_image": "debian:12-slim",                          // optional — run inside this image
  "env": { "FOO": "bar" },                                   // optional — env for the command
  "timeout": 30000,                                           // optional — ms; 0/unset = server default
  "sandbox": false                                            // optional — isolated environment
}
```

Response (HTTP 200):

```jsonc
{
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "elapsed_ms": 123,
  "sandbox_id": "docker-1a2b3c",   // present only for sandbox=true runs
  "error": "timeout"                 // present only on timeout/failure
}
```

Validation errors → HTTP `400 { "error": "..." }`. Unauthorized → HTTP `401`. Not found → `404`.

## Endpoints

| Method | Path                     | Auth | Purpose |
|--------|--------------------------|------|---------|
| `GET`  | `/healthz`               | no   | Liveness probe (`{ "status": "ok", "uptime": ... }`). |
| `POST` | `/run`                   | yes  | Run a command (the REST contract above). |
| `POST` | `/mcp`                   | yes  | MCP JSON-RPC wrapper (`initialize`, `tools/list`, `tools/call`). |
| `POST` | `/sandbox/callback/:id`  | yes  | Result callback for `sandbox=true` (hcloud provider) runs. |

### `/mcp` — Model Context Protocol surface

The server also speaks JSON-RPC 2.0 over `POST /mcp`, exposing a single tool,
`hetzner_exec_run`, whose `arguments` are the request schema above. This lets it be
registered as an MCP server in Zo (see [Registration](#registration)) even when the host
only supports the stdio transport — `scripts/mcp-stdio-bridge.ts` proxies stdin ↔ the
HTTP `/mcp` endpoint.

Supported methods: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.

## Authentication

Bearer token. Every auth-gated route requires:

```
Authorization: Bearer <HETZNER_EXEC_TOKEN>
```

The token is compared constant-time against `HETZNER_EXEC_TOKEN`. Set it to a long random
shared secret, or to a Zo access token. The server **fails closed** — it refuses to boot
if `HETZNER_EXEC_TOKEN` is unset.

## Execution modes

| `sandbox` | `docker_image` | What happens |
|-----------|-----------------|--------------|
| false (default) | unset  | `sh -c "$command"` on the host. |
| false           | set    | `docker run --rm <image> sh -c "$command"` (env passed via `-e`). |
| true            | any    | Delegated to the active **sandbox provider**. |

Timeouts are enforced by `SIGKILL` after `timeout` ms (or the server default); a timeout
returns `exit_code: 124` and `error: "timeout"`.

### Sandbox providers (`HETZNER_EXEC_SANDBOX_PROVIDER`)

- **`docker`** (default) — `docker run --rm --network=none <image|default> sh -c "$command"`.
  Zero egress. The server captures stdout/stderr directly (no callback needed). Requires
  the Docker socket (the container deployment mounts `/var/run/docker.sock`).
- **`hcloud`** — provisions a **fresh Hetzner VM**, runs the command inside it, and
  destroys it. The VM's cloud-init locks egress so the **only** outbound destination is
  the server's `/sandbox/callback/:id` (the result POST). The server registers a pending
  promise, the VM POSTs `{exit_code,stdout,stderr,elapsed_ms}`, the promise resolves, and
  the server destroys the VM. Requires `HETZNER_API_TOKEN` + `HETZNER_EXEC_PUBLIC_URL`.
  Server type / image / location / SSH key are configurable (see `deploy/env.example`).

> **Shadow-phase note:** the `hcloud` provider is fully implemented and unit-tested with
> injected fakes, but is **not** exercised against a live Hetzner box in this phase (no
> `HETZNER_API_TOKEN`, no live VM) — consistent with ZOU-414's deferral of live
> provisioning. The `/run echo hello` smoke test uses the host (non-sandbox) path.

## Configuration

All config is environment-based (see `src/config.ts` / `deploy/env.example`):

| Env | Default | Meaning |
|-----|---------|---------|
| `HETZNER_EXEC_TOKEN` | — (required) | Bearer secret. |
| `HETZNER_EXEC_PORT` | `6666` | Listen port. |
| `HETZNER_EXEC_SANDBOX_PROVIDER` | `docker` | `docker` \| `hcloud`. |
| `HETZNER_EXEC_DEFAULT_IMAGE` | `debian:12-slim` | Image when none specified. |
| `HETZNER_EXEC_DEFAULT_TIMEOUT_MS` | `30000` | Default timeout. |
| `HETZNER_EXEC_MAX_TIMEOUT_MS` | `3600000` | Hard cap on `timeout`. |
| `HETZNER_EXEC_PUBLIC_URL` | — | Public URL (hcloud callback target). |
| `HETZNER_API_TOKEN` | — | Hetzner Cloud token (hcloud provider). |
| `HETZNER_SANDBOX_*` | see `env.example` | VM type/image/location/SSH key name. |

## Ephemeral factory worker

The job-scoped worker is separate from the long-running MCP server. It creates a
fresh Hetzner server, transfers one repository snapshot over an ephemeral SSH
key, runs the checked-in command manifest, retrieves declared artifacts, writes
an evidence record, and deletes both the server and SSH key in `finally`.

Programmatic callers may pass a bounded `remoteEnv` map for credentials needed by
a command. Values are transferred in a mode-`0600` temporary script, sourced only
inside the worker, omitted from command/evidence records, and destroyed with the
VM. Evidence records only the sorted variable names.

```bash
HCLOUD_TOKEN=... bun scripts/ephemeral-worker.ts run \
  --workdir /home/workspace/Projects/iron-meridian-fps \
  --manifest /home/workspace/Projects/iron-meridian-fps/.factory/external-compute.json \
  --evidence-dir /home/workspace/Projects/zouroboros-software-factory/evaluations/external-compute/manual-smoke
```

Defaults are `ccx33`, `ubuntu-24.04`, `hel1`, a 60-minute TTL, and a
`$0.50` preflight ceiling. The live hourly price is read from Hetzner before
provisioning; the worker is refused if the TTL estimate exceeds the manifest
ceiling. Every server is labeled `zouroboros_worker=ephemeral` and
`expires_unix=<unix-seconds>` so the independent reaper can remove a worker
left behind by a killed parent process:

```bash
bun scripts/ephemeral-worker.ts reap --dry-run
bun scripts/reaper-loop.ts
```

Repositories opt in through `.factory/external-compute.json`; see
`examples/external-compute.json`. The software factory also requires its
durable `config/external-compute.json` enablement (or `SF_EXTERNAL_COMPUTE=1`).
Set `SF_EXTERNAL_COMPUTE=0` as the emergency kill switch. A repository manifest
cannot spend money by itself.

## Persistent shadow control plane

The control-plane process is separate from both the command-execution server and
the ephemeral VM worker. It accepts only allowlisted assignment identifiers and
metadata, persists atomic job snapshots plus an append-only event ledger, and
uses renewable leases, restart reconciliation, bounded retry, cancellation, and
dead letters. Its built-in executor is permanently restricted to `mode=shadow`
and records a verification checkpoint without invoking a model, shell, repository,
Linear API, pull request, or Hetzner provisioning API.

```bash
HETZNER_CONTROL_PLANE_MODE=shadow \
HETZNER_CONTROL_PLANE_TOKEN=... \
HETZNER_CONTROL_PLANE_STATE_DIR=/var/lib/zouroboros-control-plane \
bun scripts/control-plane.ts
```

The authenticated API listens on `127.0.0.1:6670` by default:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Unauthenticated liveness and shadow-mode check. |
| `POST` | `/v1/jobs` | Submit an idempotent sanitized shadow job. |
| `GET` | `/v1/jobs` | List durable jobs. |
| `GET` | `/v1/jobs/:id` | Read one job. |
| `POST` | `/v1/jobs/:id/cancel` | Cancel non-terminal work. |
| `POST` | `/v1/jobs/:id/heartbeat` | Renew the current exclusive lease. |
| `POST` | `/v1/reconcile` | Recover expired leases after restart. |
| `POST` | `/v1/tick` | Run one no-side-effect shadow work cycle. |

The factory-side adapter reads existing assignment JSON files independently of
the production dispatcher and mirrors only an allowlist. Fields such as prompts,
commands, model identifiers, environment maps, credentials, and local filesystem
paths are neither sent nor stored.

```bash
HETZNER_CONTROL_PLANE_URL=http://private-control-plane:6670 \
HETZNER_CONTROL_PLANE_TOKEN=... \
bun scripts/shadow-adapter.ts sync --dir /path/to/factory-state/assignments
```

For a persistent Hetzner deployment, build `Dockerfile.control-plane`, copy
`deploy/control-plane.env.example` to `/etc/zouroboros-control-plane/env`, and
install `deploy/hetzner-control-plane.service`. The service mounts
`/var/lib/zouroboros-control-plane` at `/state`; recreating the container does not
discard jobs or audit evidence. Port `6670` must be limited to a private network,
VPN, or authenticated reverse proxy. Public clear-text exposure is unsupported.

## Deployment

### Container (recommended — uses the Docker from ZOU-414)

```bash
# On the Hetzner box (Docker already installed by ZOU-414 cloud-init):
cp -r packages/hetzner-exec /opt/hetzner-exec
sudo cp /opt/hetzner-exec/deploy/env.example /etc/hetzner-exec/env   # edit real values
sudo docker build -t hetzner-exec:0.1.0 /opt/hetzner-exec
sudo cp /opt/hetzner-exec/deploy/hetzner-exec.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hetzner-exec
```

UFW (from ZOU-414) already allows `6666/tcp`. Verify: `curl -s http://localhost:6666/healthz`.

### Host (bun directly)

Install bun, then run `HETZNER_EXEC_TOKEN=… bun src/main.ts`. Adjust the systemd unit
to `ExecStart=/usr/local/bin/bun src/main.ts` with `WorkingDirectory=/opt/hetzner-exec`.

## Registration <a id="registration"></a>

`scripts/register-mcp.ts` emits a Zo-compatible `.mcp.json` entry that uses the stdio↔HTTP
bridge (`scripts/mcp-stdio-bridge.ts`), so it registers as a `command`-based MCP server
even though the server itself is HTTP:

```bash
HETZNER_EXEC_PUBLIC_URL=https://box.example.com bun scripts/register-mcp.ts
# → prints the 'hetzner-exec' entry; writes packages/hetzner-exec/mcp-registration.json
```

Merge the printed `hetzner-exec` entry into `~/.mcp.json` (replace the
`<set-to-HETZNER_EXEC_TOKEN-secret>` placeholder with the real secret). **Apply only after
the box is live** — the bridge points at `HETZNER_EXEC_PUBLIC_URL`.

## Development

```bash
# Type check (must be zero errors)
bunx tsc --noEmit -p tsconfig.json

# End-to-end smoke test (boots the real server in-process; runs `echo hello` over HTTP)
bun scripts/smoke-test.ts

# Unit tests (auth, validation, arg builders, docker + hcloud sandbox with fakes)
bun test/selftest.ts
bun test test/ephemeral-worker.test.ts
bun test test/control-plane.test.ts
bun scripts/control-plane-smoke.ts
```

The package is **zero-dependency** (only `node:*` APIs + the platform `fetch`); it runs on
Bun and Node 18+. Type declarations come from `@types/node` (see `tsconfig.json`).
