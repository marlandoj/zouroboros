# Quick Start Tutorial

> Get a fresh Zouroboros install working in 10 minutes

This walkthrough uses only the **MVP** — the `cli`, `core`, and `memory`
packages that work on a fresh box with no extra services. The optional
subsystems (swarm, workflow, self-heal) are covered at the end and are clearly
marked as needing extra setup.

## Prerequisites

- **Bun** (required): `curl -fsSL https://bun.sh/install | bash`
- **Git** and **`sqlite3`** on your PATH

See [installation.md](./installation.md) if you haven't installed the CLI yet.

## Step 1: Initialize

```bash
# Create a working directory
mkdir my-zouroboros-project
cd my-zouroboros-project

# Initialize configuration + memory database
zouroboros init

# Verify setup
zouroboros doctor
```

`zouroboros doctor` checks each component and **exits 0 when the MVP is
healthy**. On a fresh box you'll see green checks for the core pieces and a few
yellow warnings for optional add-ons you haven't installed yet — that's
expected:

```
✓ Configuration        Found at ~/.zouroboros/config.json
✓ Memory Database      0 facts, 0 embeddings
⚠ Embeddings           OPENAI_API_KEY not set. Vector search auto-disabled — memory runs in text/FTS-only mode.
⚠ Swarm Executors      None found. Not required for memory or the gate — install one to enable swarm execution.
✓ Git                  Available
⚠ Scheduled Agents     ... After creating in Zo Chat, run: zouroboros agents sync

⚠  Some issues found
```

Warnings do not fail the check. If you see a red `✗` (for example a missing
config, or `git` not on PATH), fix that before continuing — those are the only
things that make `doctor` exit non-zero.

## Step 2: Store Your First Memory

```bash
zouroboros memory store \
  --entity "user" \
  --key "favorite_language" \
  --value "TypeScript" \
  --decay permanent
```

Verify it was stored:

```bash
zouroboros memory search "favorite language"
```

Output:
```
🔍 Search Results (1 found)
━━━━━━━━━━━━━━━━━━━━━
📌 [[user]].favorite_language
   TypeScript
   Category: preference | Decay: permanent
```

Memory works in text/FTS-only mode out of the box. Set `OPENAI_API_KEY` before
`zouroboros init` (or export it and re-run) to enable vector search with
`text-embedding-3-small`.

## Step 3: Keep the Schema Current

Migrations are idempotent — run this any time to bring the DB to the latest
schema:

```bash
zouroboros migrate up
```

That's the whole MVP loop: **init → doctor → memory → migrate**.

---

## Spec-First Workflow (no executor or API key required)

The interview → seed → Stage 1 evaluation loop is fully deterministic. It runs
on a fresh clone with **no swarm executor and no `OPENAI_API_KEY`** — Stage 1 is
mechanical verification (compile, lint, tests). Stages 2–3 add semantic and
consensus review; only Stage 3 consensus needs models.

### Step 1: Run the interview

Print the Socratic interview framework for your topic:

```bash
zouroboros workflow interview --topic "Build a todo list API"
```

### Step 2: Generate a seed specification

Turn a topic (and optional interview notes) into a draft seed YAML. The file is
written to the `--output` directory as `seed-<timestamp>.yaml`:

```bash
zouroboros workflow interview seed \
  --topic "Build a todo list API" \
  --output .
# → ✓ Seed specification written to: ./seed-<timestamp>.yaml
```

The seed is a **draft skeleton**: `goal` is set from `--topic`, and
`constraints` / `acceptance_criteria` are `TODO` placeholders (or extracted from
`--from <notes.md>` when provided). Fill it in before relying on Stage 2/3.

### Step 3: Run a Stage 1 evaluation

Evaluate any project directory against the seed. `--stage 1` runs only the
mechanical checks, so no API key is needed:

```bash
zouroboros workflow evaluate \
  --seed ./seed-<timestamp>.yaml \
  --artifact ./path/to/project \
  --stage 1
# → Stage 1: Mechanical Verification  ✓ PASSED
```

Or run Stage 1 against the current workspace directly:

```bash
zouroboros workflow evaluate --self-test
```

That's the whole spec-first loop: **interview → seed → evaluate --stage 1**.

## Optional Add-ons (need a swarm executor)

The following subsystems are deferred from the MVP. Each needs at least one
**swarm executor** on your PATH — `claude`, `codex`, `gemini`, or `hermes`.
Install one, then re-run `zouroboros doctor` to confirm it's detected:

```bash
npm install -g @anthropic-ai/claude-code   # or @openai/codex, @google/gemini-cli
```

### Swarm Campaign

Create `campaign.json`:

```json
{
  "tasks": [
    { "id": "1", "persona": "Backend Developer", "task": "Design the database schema for a todo app", "priority": "high" },
    { "id": "2", "persona": "API Developer", "task": "Create REST endpoints for CRUD operations", "priority": "high", "dependsOn": ["1"] }
  ]
}
```

```bash
zouroboros swarm run --tasks ./campaign.json --output ./results
```

### Self-Heal Introspection

```bash
zouroboros heal introspect --verbose
```

## Quick Reference

### MVP commands

| Command | Purpose |
|---------|---------|
| `zouroboros init` | Initialize config + memory DB |
| `zouroboros doctor` | Check system health |
| `zouroboros memory store` | Save a fact |
| `zouroboros memory search` | Find facts |
| `zouroboros migrate up` | Update DB schema |

### Spec-first commands (no executor or API key)

| Command | Purpose |
|---------|---------|
| `zouroboros workflow interview` | Print the spec-first interview framework |
| `zouroboros workflow interview seed` | Generate a draft seed YAML from a topic/notes |
| `zouroboros workflow evaluate --stage 1` | Run Stage 1 mechanical verification |
| `zouroboros workflow evaluate --self-test` | Stage 1 checks on the current workspace |

### Optional commands (need an executor)

| Command | Purpose |
|---------|---------|
| `zouroboros swarm run` | Execute campaign |
| `zouroboros heal introspect` | Health scorecard |
| `zouroboros tui` | Launch dashboard |

## What's Next?

- **[Installation Guide](./installation.md)** - Full setup + Zo integration
- **[CLI Commands](../reference/cli-commands.md)** - Full command reference
