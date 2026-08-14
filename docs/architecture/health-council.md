# Health Council

The Zouroboros Health Council is the system's self-monitoring layer — four autonomous watchers, each responsible for a distinct layer of the stack. Together they form a closed loop: detect drift, diagnose root cause, prescribe fixes, and (with approval) apply them.

## Seats

| Seat | Skill | Layer | What It Watches | Cadence |
|------|-------|-------|-----------------|---------|
| **Healer** | `agent-model-healer` | Runtime | Model availability — detects 402/429/503/timeout failures and switches agents to healthy fallbacks. Restores originals when models recover. | Every 2 hours |
| **Doctor** | `agent-doctor` | Orchestration | Agent fleet fitness — 11 diagnostic checks covering cost, frequency, zombies, duplicates, tool errors, persona fitness, instruction hygiene, schedule collisions, delivery noise, instruction length, and output delta. | Weekly |
| **Introspector** | `agent-introspect` | Capability | Skill library health, identity file drift, capability gaps. Audits scripts, references, and IDENTITY files across all personas. | Weekly |
| **Steward** | Memory Manager (persona) | Knowledge | Memory contradictions, decay status, graph connectivity, embedding coverage. Runs conflict resolution, scorecard introspection, and capture pipelines. | Daily |

## Design Principles

1. **No overlap** — Each seat watches exactly one layer. The Healer never touches agent configuration; the Doctor never touches memory. Clear boundaries prevent conflicting prescriptions.

2. **Report-only by default** — All four seats produce diagnostic reports. None auto-apply changes without explicit approval. The system observes and recommends; humans decide.

3. **Budget-conscious** — Every seat runs on the cheapest model that can do the job (Haiku or equivalent). The council practices what the Doctor prescribes.

4. **Same loop, different scope** — Each seat follows the introspect → prescribe → evolve pattern from `zouroboros-selfheal`, applied to its own domain.

## How They Work Together

```
Runtime Layer        ┌──────────┐
  Model failures ───▶│  Healer  │──▶ Failover / restore
                     └──────────┘

Orchestration Layer  ┌──────────┐
  Agent fleet ──────▶│  Doctor  │──▶ Cost, frequency, zombie findings
                     └──────────┘

Capability Layer     ┌──────────────┐
  Skills/Identity ──▶│ Introspector │──▶ Broken scripts, drift, gaps
                     └──────────────┘

Knowledge Layer      ┌──────────┐
  Memory graph ─────▶│ Steward  │──▶ Contradictions, decay, coverage
                     └──────────┘
```

The Healer operates at the fastest cadence (2 hours) because model outages need immediate response. The Steward runs daily because memory accumulates continuously. The Doctor and Introspector run weekly because agent configuration and skill libraries change infrequently.

## Diagnostic Checks

### Healer (`agent-model-healer`)
- Probes each model endpoint for health
- Detects: 402 (credits), 429 (rate limit), 503 (unavailable), timeout
- Applies fallback chain: switches affected agents to next healthy model
- Restores original model when the failure clears
- Safety rule: healer must not share a model with agents it monitors

### Doctor (`agent-doctor`)
11 checks across the agent fleet:

| # | Check | What It Catches |
|---|-------|-----------------|
| 1 | Cost Fitness | Agents on models more expensive than their task complexity warrants |
| 2 | Frequency Waste | Agents whose last N runs produced identical output |
| 3 | Zombie Projects | Agents tied to projects marked complete in their plan files |
| 4 | Duplicates | Multiple agents with overlapping instructions or schedules |
| 5 | Tool-Call Errors | Agents with repeated tool invocation failures in logs |
| 6 | Persona Fitness | Agents running under personas mismatched to their task domain |
| 7 | Instruction Hygiene | Instructions referencing nonexistent files, stale paths, or removed tools |
| 8 | Schedule Collisions | Multiple agents scheduled within the same time window |
| 9 | Delivery Noise | Agents sending emails/SMS that could be log-only |
| 10 | Instruction Length | Instructions exceeding model context limits |
| 11 | Output Delta | Agents whose output hasn't changed across recent runs |

### Introspector (`agent-introspect`)
3 audit modes:

- **`audit`** — Inventories skills, workspace structure, identity files, memory samples
- **`health`** — Checks each skill's scripts for executability, missing dependencies, stale references
- **`gaps`** — Searches memory for recurring limitations and manual workarounds, proposes new skills

### Steward (Memory Manager)
- **Conflict Resolution** — Finds contradictory facts and resolves them
- **Scorecard** — 7-metric health composite (memory recall, graph connectivity, routing accuracy, eval calibration, procedure freshness, episode velocity, skill effectiveness)
- **Capture Pipeline** — Daily memory capture, embedding backfill, decay processing

## Origin

The Health Council emerged from a manual agent optimization session (2026-04-12) where auditing 33 scheduled agents revealed:

- 2 agents running on Opus (the most expensive model) for simple script execution — 76% of total agent spend
- Agents firing hourly with zero output delta
- Zombie agents for projects marked complete months ago
- Tool-call failures from model/capability mismatches

The manual process was codified into the Doctor skill, the Introspector was adapted from the community `self-improvement` skill (dropping memory hygiene since Memory Manager already covers that), and the four seats were formalized as the Health Council.

## Related

- [Architecture Overview](./overview.md) — System design and package structure
- [`zouroboros-selfheal`](../../packages/selfheal/) — The introspect → prescribe → evolve engine that each seat builds on
- [`Skills/agent-model-healer`](../../Skills/agent-model-healer/) — Healer implementation
- [`agents/`](../../agents/) — Scheduled agent manifests
