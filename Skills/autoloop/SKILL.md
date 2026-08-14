---
name: autoloop
description: Run a bounded, Git-backed optimization loop against one tracked file and one numeric metric. Use for measurable prompt, policy, configuration, or algorithm refinement where each candidate can be evaluated deterministically. Do not use for open-ended editorial cleanup, multi-file migrations, production mutation, or worktrees containing unrelated tracked changes.
---

# Autoloop

Optimize one tracked file through repeated propose, measure, keep, or discard experiments.

## Preconditions

- Use an isolated, clean Git worktree. The command refuses tracked changes.
- Commit the target file before starting.
- Define one numeric metric with an unambiguous direction.
- Keep the evaluation command deterministic, non-interactive, and bounded.
- Use held-out cases in the metric when optimizing prompts or skills to reduce metric gaming.
- Set explicit experiment, duration, and cost limits.

Autoloop uses `git reset --hard HEAD~1` only after its own experiment commit. The clean-worktree and single-target gates are mandatory safeguards, not optional advice.

## Start A Campaign

```bash
cp Skills/autoloop/assets/template.program.md /path/to/clean-worktree/program.md
bun Skills/autoloop/scripts/autoloop.ts --program /path/to/clean-worktree/program.md --dry-run
bun Skills/autoloop/scripts/autoloop.ts --program /path/to/clean-worktree/program.md
```

Use `--executor codex`, `--executor gemini`, or another installed bridge when needed. The default is `claude-code`.

## CLI

```text
--program <path>     Program definition; required except with --help
--executor <name>    Proposal executor; default claude-code
--resume             Resume today's existing campaign branch
--dry-run            Validate and display configuration without changing Git
--help               Show usage
```

Each campaign creates `autoloop/<name>-<date>`, `results.tsv`, and a final `autoloop-summary-<name>.md`. Regressions are discarded; improvements remain as discrete commits.

Cost enforcement uses `metrics.totalCostUsd` from executor bridge result files. The summary reports calls without cost telemetry; treat a positive count as an unenforced portion of the budget.

## Program Contract

Define these sections in `program.md`:

- `Objective`
- `Metric`: name, `lower_is_better` or `higher_is_better`, and a shell extractor that prints one number
- `Setup`
- `Target File`
- `Run Command`
- `Read-Only Files`
- `Constraints`: per-run time, experiments, duration, and USD cost
- `Stagnation`
- `Notes`

The per-run time accepts seconds, minutes, or hours. Run `--dry-run` after every program change.

## MCP Server

```bash
bun Skills/autoloop/scripts/mcp-server.ts
bun Skills/autoloop/scripts/mcp-server-http.ts
```

The servers expose `autoloop_start`, `autoloop_status`, `autoloop_results`, `autoloop_stop`, and `autoloop_list`.

## Resources

- `assets/template.program.md`: campaign template
- `references/autoresearch-patterns.md`: design rationale and experimental patterns
- `scripts/autoloop.test.ts`: safety and parsing tests

## Verify

```bash
bun test Skills/autoloop/scripts/autoloop.test.ts
bunx tsc --noEmit --skipLibCheck --target esnext --module esnext --moduleResolution bundler --types bun Skills/autoloop/scripts/autoloop.ts Skills/autoloop/scripts/autoloop.test.ts
```
