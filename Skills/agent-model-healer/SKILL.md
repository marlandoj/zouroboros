---
name: agent-model-healer
description: Zouroboros self-healing watchdog that monitors scheduled agent models and automatically switches failing agents to backup models, restoring originals when they recover.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: "2.0.0"
  category: zouroboros-infrastructure
---

## Agent Model Healer

Self-healing model fallback system for Zouroboros scheduled agents.

### Problem

Zo scheduled agents are configured with a single model. When that model becomes unavailable
(insufficient credits, rate limits, provider outage), the entire agent task fails silently
with only an email notification. There is no platform-level retry or fallback.

### Solution (v2 — zero-cost orchestration)

A dedicated independent watchdog model runs `healer.ts auto` every hour. The script is fully autonomous — all orchestration uses **direct MCP API calls** (zero model cost). The only AI cost is the probe prompts (~5 tokens × ~10 models = negligible).

1. **Probe** — Tests all configured models with a tiny prompt via `/zo/ask`
2. **List** — Fetches automations via direct MCP `list_automations` (zero cost)
3. **Heal** — Switches automations on unhealthy models via direct MCP `edit_automation` (zero cost)
4. **Restore** — When original models recover, restores agents to their preferred model
5. **Notify** — Sends email via direct MCP `send_email_to_user` only when actions taken
6. **State** — Tracks all switches in `.zouroboros/healer-state.json` for audit

### Usage

```bash
# Full autonomous pipeline (what the agent runs)
bun Skills/agent-model-healer/scripts/healer.ts auto

# Check model health
bun Skills/agent-model-healer/scripts/healer.ts probe

# Validate the host-local fallback policy before an autonomous run
bun Skills/agent-model-healer/scripts/healer.ts validate

# See current state
bun Skills/agent-model-healer/scripts/healer.ts status

# Legacy: probe + output instructions (manual use)
bun Skills/agent-model-healer/scripts/healer.ts run
```

### Safety: Watchmen Independence Rule

**The healer agent MUST run on a model that is NOT in any fallback chain it monitors.**

If the healer shares a model with the agents it heals, a single provider outage can kill both the healer and its patients — a cascade where nothing can self-repair. The live deployment uses the dedicated Tencent Hunyuan 3 Free BYOK model, which is excluded from every monitored fallback chain. This keeps the watchman independent from Claude Code, Codex, and Kimi failures.

This is enforced in `healerConfig` within `assets/fallback-chain.json`.

### Architecture: Why an independent watchman + Direct MCP

| Concern | v1 (Zo agent on Sonnet) | v2 (independent watchman + direct MCP) |
|---------|------------------------|---------------------------|
| Agent model cost | 48 Sonnet calls/day | 24 lightweight watchman calls/day |
| Tool call cost | AI interprets JSON → calls tools | Direct HTTP to MCP endpoint (zero) |
| Watchmen safety | Shared provider risk | Healer model is excluded from every monitored chain |
| Autonomy | Agent interprets instructions | Script executes deterministically |

### Configuration

Edit `assets/fallback-chain.json` to:
- Add/remove models from fallback chains
- Adjust probe timeout and retry settings
- Update model labels for readability
- **Never** add the configured `healerConfig.model` to a fallback chain

The active `fallback-chain.json` is host-local and intentionally ignored by Git because its
model IDs are deployment-specific. Start from `fallback-chain.example.json`, keep the local
file synchronized when policy changes, and run `healer.ts validate` after every edit.

### Files

- `scripts/healer.ts` — Main healer engine (auto, probe, diagnose, status, run)
- `assets/fallback-chain.json` — Fallback chain config and model labels
- `/home/workspace/.zouroboros/healer-state.json` — Runtime state (switches, probe results)
- `/dev/shm/agent-model-healer.log` — Operational log

### Watchdog Agent

The healer runs as a scheduled Zo agent every hour on its dedicated independent model. The agent simply executes `bun healer.ts auto` — all logic is in the script, not the AI.
