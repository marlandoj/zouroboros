# Swarm Orchestrator Changelog

## Current

### Hierarchical orchestration telemetry
- persisted delegated child telemetry into task results, NDJSON logs, episode metadata, and executor history
- fed delegation telemetry back into routing so delegation-friendly executors are preferred for eligible tasks
- added deterministic validation fixtures for Hermes delegation, conditional Claude delegation, blocked mutation delegation, and auto-routed hierarchical work

### Operator observability
- added richer `status <swarm-id>` output with delegated parent count, child count, artifact count, reroutes, and effective executors
- added `history [limit]` to inspect delegation-aware executor history directly from `executor-history.db`

### Documentation cleanup
- aligned package docs with the current v5 runtime and CLI surface
- removed obsolete legacy-era documents and examples that referenced deprecated orchestrator generations

## Runtime notes
- `scripts/orchestrate-v5.ts` is the current TypeScript orchestrator entrypoint
- `scripts/swarm-hybrid-runner.ts` remains the long-running handoff wrapper
- Python support remains available through `orchestrate.py` where documented
