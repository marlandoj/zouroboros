# zouroboros-cli

> Unified command-line interface for Zouroboros

## Prerequisites

The CLI runs on **[Bun](https://bun.sh)** — it uses `bun:sqlite` for the memory
database and will not run under plain Node.

- **Bun** (required): `curl -fsSL https://bun.sh/install | bash`
- **Git** (required): used by the workflow/autoloop commands
- **SQLite 3** (`sqlite3` on PATH): used by `doctor` and migrations — usually
  pre-installed on macOS/Linux
- **Node.js 18+** (optional): only needed if you install the optional swarm
  executors, which ship as npm packages

## Installation

Until the package is published, install from source:

```bash
git clone https://github.com/marlandoj/zouroboros.git
cd zouroboros
npm install -g pnpm      # if you don't have pnpm
pnpm install
pnpm run build
cd cli && pnpm link --global
```

`zouroboros` is now on your PATH.

## Quick Start (MVP)

```bash
# Initialize configuration + memory database
zouroboros init

# Check health — should exit 0 on a fresh box
zouroboros doctor

# Store and search a fact
zouroboros memory store --entity user --key favorite_language --value TypeScript
zouroboros memory search "favorite language"
```

`doctor` reports optional components (swarm executors, scheduled agents) as
**warnings**, not errors — the MVP (memory + gate) is healthy without them. See
[../docs/getting-started/quickstart.md](../docs/getting-started/quickstart.md)
for the full walkthrough.

## Commands

### Core (MVP — work out of the box)

| Command | Description |
|---------|-------------|
| `init` | Initialize configuration + memory DB |
| `doctor` | Health check |
| `config` | Manage configuration |
| `memory` | Store, search, and manage facts |
| `migrate` | Bring the memory DB to the latest schema |

### Optional add-ons

These commands drive deferred subsystems and need extra setup — at least one
swarm executor (`claude`, `codex`, `gemini`, or `hermes`) on your PATH, and in
some cases a Zo Computer connection. `zouroboros doctor` will tell you what's
missing.

| Command | Description | Needs |
|---------|-------------|-------|
| `swarm` | Multi-agent campaign orchestration | an executor |
| `workflow` | Interview, evaluate, autoloop | an executor |
| `persona` | Persona management | — |
| `heal` | Self-healing / introspection | an executor |
| `tui` | Launch dashboard | — |

## Examples

```bash
# Initialize + verify
zouroboros init
zouroboros doctor

# Search memory
zouroboros memory search "project requirements"

# Optional: run a swarm campaign (requires an executor on PATH)
zouroboros swarm run tasks.json --strategy reliable
```
