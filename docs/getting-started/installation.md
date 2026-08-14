# Installation Guide

> Get Zouroboros up and running in minutes

## Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/marlandoj/zouroboros/main/scripts/install.sh | bash
```

This will:
- Clone the repository
- Install dependencies
- Set up configuration
- Run health checks

## Manual Installation

### Prerequisites

- **Bun** (required): `curl -fsSL https://bun.sh/install | bash`
- **Node.js** 18+ (optional, for some tools)
- **Git**
- **SQLite** (usually pre-installed)

### Step 1: Clone the Repository

```bash
git clone https://github.com/marlandoj/zouroboros.git
cd zouroboros
```

### Step 2: Install Dependencies

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install all package dependencies
pnpm install

# Build all packages
pnpm run build
```

### Step 3: Initialize Configuration

```bash
# Run the setup wizard
./scripts/setup.sh

# Or use the CLI
pnpm zouroboros init
```

### Step 4: Verify Installation

```bash
# Run the doctor command
zouroboros doctor

# Should show all components as healthy
```

## Configuration

### Environment Variables

Zouroboros honors a small set of environment variables but runs fine with the
defaults. Create a `.env` file in your project root only if you need to override
them:

```bash
# Optional — defaults to ~/.zouroboros/memory.db
ZOUROBOROS_MEMORY_DB=/path/to/your/memory.db

# Optional — defaults to the current working directory
ZOUROBOROS_WORKSPACE=/path/to/your/project

# Optional — for cloud features
OPENAI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
```

Legacy `ZO_MEMORY_DB` and `ZO_WORKSPACE` names are still accepted for
backwards compatibility.

### Zo Computer Integration

If you're using Zo Computer and want Zouroboros to share the same memory DB as
other Zo tooling, export `ZOUROBOROS_MEMORY_DB` **before** running
`zouroboros init` so the CLI initialises the shared DB instead of creating a
separate `~/.zouroboros/memory.db`. Add the following to your `~/.bashrc` or
`~/.zshrc`:

```bash
# Point Zouroboros at the shared Zo memory database
# (run BEFORE `zouroboros init` so the schema is created in the right file)
export ZOUROBOROS_MEMORY_DB="$HOME/.zo/memory/shared-facts.db"

# Zouroboros CLI
export PATH="$PATH:/home/workspace/zouroboros/cli/bin"

# Optional — install exported skills into the Zo workspace Skills dir
export ZOUROBOROS_WORKSPACE="/home/workspace"

# Handy aliases
alias zm='zouroboros memory'
alias zs='zouroboros swarm'
alias zp='zouroboros persona'
```

Reload your shell (`source ~/.bashrc`) and then run:

```bash
zouroboros init
zouroboros migrate up   # idempotent — brings the DB to the latest schema
```

`zouroboros skills install` will now export to `/home/workspace/Skills/` (the
Zo native skills directory) instead of `/root/Skills/`.

> If you already ran `zouroboros init` without `ZOUROBOROS_MEMORY_DB` set, you
> now have two databases: `~/.zouroboros/memory.db` (empty) and
> `~/.zo/memory/shared-facts.db` (the one Zo tooling writes to). You can
> safely delete the empty `~/.zouroboros/memory.db` and re-run
> `zouroboros init` with the env var exported.

## Next Steps

- [Quick Start Tutorial](./quickstart.md) - Build your first project
- [Configuration Reference](../reference/configuration.md) - Advanced settings
- [CLI Commands](../reference/cli-commands.md) - Full command reference

## Troubleshooting

### Common Issues

**Issue**: `zouroboros: command not found`
**Solution**: Ensure the CLI is linked: `cd cli && pnpm link --global`

**Issue**: `Cannot find module 'zouroboros-core'`
**Solution**: Run `pnpm run build` from the root directory

**Issue**: SQLite errors
**Solution**: Ensure SQLite is installed: `sqlite3 --version`

### Getting Help

- Check the [Troubleshooting Guide](../reference/troubleshooting.md)
- Open an issue on GitHub
- Ask in the Zo Computer community