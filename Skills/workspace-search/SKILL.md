---
name: workspace-search
description: Run exact content or filename searches within a bounded Zo workspace directory using enforced ignore rules, result limits, internal timeouts, process-group cleanup, partial results, and structured telemetry. Use only when codebase-memory or semantic retrieval cannot answer the request, when files are not indexed, or when an exact text/configuration/freshness check is required.
---

# Workspace Search

Use `codebase-memory` first for indexed code structure, callers, definitions, and impact analysis.
Use this skill only for exact or unindexed fallback searches.

Run:

```bash
bun /home/workspace/Skills/workspace-search/scripts/workspace-search.ts \
  --root /home/workspace/<smallest-known-directory> \
  --query '<pattern>' \
  --kind content
```

Use `--kind filename` to locate files. Add `--include '<glob>'`, repeatable
`--exclude '<glob>'`, `--ignore-case`, or `--regex` only when required.

The command:

- rejects roots outside `/home/workspace`;
- enforces dependency/build exclusions and also applies `/home/workspace/.ignore` when present;
- defaults to a 30-second deadline and 200 results;
- terminates the full ripgrep process group on timeout or result cap;
- emits JSON with `status`, `partial`, `results`, and phase telemetry;
- appends query-hashed telemetry to `/dev/shm/workspace-search.jsonl`.

Always inspect `status`. A `timeout` result is partial and exits `124`; retain its
results, narrow the root or include glob, and retry once. Do not replace it with
an unscoped workspace-wide `grep_search` call.
