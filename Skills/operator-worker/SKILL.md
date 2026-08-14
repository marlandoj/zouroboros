---
name: operator-worker
description: Cross-Zo orchestrator → worker dispatch helper. Sends prompts and files between this Zo and a worker Zo (faunaflora) via the /zo/ask API using ZO_B_API_KEY. Supports prompt dispatch, JSON output parsing, file get/put via base64, and task-with-file-result workflows.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# operator-worker

Cross-Zo dispatch helper. This (marlandoj) is the orchestrator; faunaflora is the worker.

## Setup

1. Worker token must be in Zo Secrets as `FAUNA_ZO_TOKEN` ([Settings > Advanced](/?t=settings&s=advanced)). `ZO_B_API_KEY` is still accepted as a legacy fallback.
2. When invoked from a fresh shell or scheduled agent, source secrets first:
   ```bash
   source /root/.zo_secrets
   ```

## Known personas on faunaflora

| Name | UUID | Role |
|------|------|------|
| `aria` | `dba6de23-bb78-405b-bbc3-11a60c5e2a38` | Chief of staff / primary persona |

Pass `--persona aria` to `ask` to address Aria directly. A raw UUID works too.

## Usage

```bash
bun /home/workspace/Skills/operator-worker/scripts/worker.ts <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `ask <prompt>` | Dispatch a prompt to the worker, print output to stdout |
| `ask --json <prompt>` | Same but parse output as JSON (pretty-print) |
| `ask --persona <name\|uuid> <prompt>` | Address a specific persona (e.g. `--persona aria`) |
| `get <remote-path> [<local-path>]` | Fetch a file from the worker (default local: `./<basename>`) |
| `put <local-path> [<remote-path>]` | Push a file to the worker (default remote: `/home/workspace/<basename>`) |
| `put-dir <local-dir> [<remote-dir>] [--concurrent N]` | Walk a directory and push every file in parallel |
| `bootstrap [<manifest>] [--concurrent N]` | Sync a curated set of files/skills/dirs from a manifest (default: `assets/bootstrap.json`) |
| `batch [--concurrent N] [--json] <prompts-file>` | Run many prompts in parallel; one prompt per line; emits JSON array of results |
| `run-task <task-id> <prompt>` | Dispatch a task; worker writes result to `/home/workspace/.orchestrator-out/<task-id>.json`, then orchestrator fetches it |
| `ping` | Identity check round-trip |

## Examples

```bash
# Dispatch a quick prompt
bun /home/workspace/Skills/operator-worker/scripts/worker.ts ask "List your top 3 user services"

# Talk to Aria by name
bun /home/workspace/Skills/operator-worker/scripts/worker.ts ask --persona aria \
  "Hi Aria — quick status check on the memory pipeline?"

# Dispatch and get back structured JSON
bun /home/workspace/Skills/operator-worker/scripts/worker.ts ask --json \
  "Return JSON {handle, hostname, uptime}. No prose."

# Push a CSV to the worker for processing
bun /home/workspace/Skills/operator-worker/scripts/worker.ts put \
  /home/workspace/Data/inputs.csv /home/workspace/Data/inputs.csv

# Run a task that writes a file on worker side, then fetch it
bun /home/workspace/Skills/operator-worker/scripts/worker.ts run-task \
  ffb-inventory-2026-05-17 \
  "Analyze /home/workspace/Data/inputs.csv and write the summary to the result file."

# Fetch the result file separately if needed
bun /home/workspace/Skills/operator-worker/scripts/worker.ts get \
  /home/workspace/.orchestrator-out/ffb-inventory-2026-05-17.json \
  ./results/ffb-inventory.json

# Identity check
bun /home/workspace/Skills/operator-worker/scripts/worker.ts ping
```

## Design Notes

- **No `model_name` in payload** — BYOK IDs are scoped per-account. Omitting it lets faunaflora use its own default model.
- **Persona targeting** — `--persona <name|uuid>` adds `persona_id` to the `/zo/ask` payload. Names resolve through an in-script registry (see `PERSONA_REGISTRY`); UUIDs pass through unchanged.
- **Worker has zero context** — every prompt is fully self-contained, no shared conversation history.
- **File transfer is base64-over-API** — the two Zos do not share a filesystem; files round-trip through `/zo/ask` prompts.
- **Billing** — all worker work bills against faunaflora's account, not this Zo.
- **Default timeout** — 5 minutes per dispatch. Override with `--timeout <ms>`.
- **Result directory on worker** — `run-task` uses `/home/workspace/.orchestrator-out/<task-id>.json` by convention.
- **Concurrency cap** — `--concurrent` is clamped to 20 (per `/zo/ask` API guidance). Default: 5.
- **Bootstrap manifest** — `assets/bootstrap.json` supports `files: [{local, remote}]`, `skills: [name]` (copies `Skills/<name>/` tree), and `dirs: [{local, remote}]`. Skipped names: `node_modules`, `.git`, `__pycache__`.
- **Batch order** — `batch` results array preserves prompt index, but execution order is non-deterministic across the concurrency pool.
