# zouroboros-rag

Retrieval-Augmented Generation for the Zouroboros ecosystem. Provides context injection across 5 areas: swarm orchestration, vault search, autoloop experiments, three-stage eval, and persona memory.

> Consolidated from `Projects/zouroboros-rag-expansion/` into the Zouroboros monorepo (2026-04-01).

## Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `rag-swarm-retrieval.ts` | Episode/procedure retrieval and completed-result capture for swarm routing | `bun scripts/rag-swarm-retrieval.ts --post-swarm ~/.swarm/results/swarm_xxx.json` |
| `vault-hybrid.ts` | Semantic + wikilink graph RRF fusion search | `bun scripts/vault-hybrid.ts --hybrid "query"` |
| `autoloop-memory.ts` | Experiment history recall for autoloop | `bun scripts/autoloop-memory.ts --query "optimize"` |
| `eval-memory.ts` | Prior eval results and AC templates | `bun scripts/eval-memory.ts --prior /path/to/file.ts` |
| `persona-memory-gate.ts` | Domain fact injection per persona | `bun scripts/persona-memory-gate.ts --persona "Alaric"` |
| `seed-rag-config.ts` | Initialize config DB with 9 RAG configs | `bun scripts/seed-rag-config.ts` |
| `daily-rag-maintenance.ts` | Unified daily maintenance for all 4 areas | `bun scripts/daily-rag-maintenance.ts run` |
| `qdrant-rag-mcp.ts` | MCP server exposing `rag_search` over Qdrant collections | `bun scripts/qdrant-rag-mcp.ts` |
| `rag-pipeline.ts` | Retrieval enhancement layer: cross-encoder rerank, HyDE, CRAG, RRF | imported by `qdrant-rag-mcp.ts` |
| `ingest-hermes-docs-hybrid.ts` | Hybrid (BM25 sparse + dense) ingest for `hermes-docs` | `bun scripts/ingest-hermes-docs-hybrid.ts` |

### Pipeline enhancements (2026-05)

`rag-pipeline.ts` adds opt-in retrieval enhancements on top of dense vector search, surfaced through `rag_search` flags on the `qdrant-rag-mcp.ts` server:

- **`--rerank`** — RankGPT-style cross-encoder reranking of candidate passages.
- **`--hybrid`** — BM25 sparse + dense fusion via Reciprocal Rank Fusion (RRF); requires a hybrid-ingested collection (see `ingest-hermes-docs-hybrid.ts`).
- **`--hyde`** — Hypothetical Document Embeddings query expansion.
- **`--crag`** — Corrective-RAG verdict with query-rewrite fallback (folds in a Self-RAG-style reflection step).

> These scripts are dual-homed: the live runtime is the zo-memory-system Skill, mirrored here for durable history. `model-client.ts` re-exports the Skill's model client to keep the copies byte-identical. Production-readiness audit: `evaluations/eval-rag-enhancements-2026-05-28.md`.

## Quick Start

```bash
cd packages/rag

# Initialize config DB
bun scripts/seed-rag-config.ts

# Index vault files
bun scripts/vault-hybrid.ts index

# Run daily maintenance
bun scripts/daily-rag-maintenance.ts run

# Check status
bun scripts/daily-rag-maintenance.ts status
```

## Dependencies

- **zo-memory-system**: Shared facts DB at `~/.zo/memory/shared-facts.db`
- **OpenAI**: Embeddings via `text-embedding-3-small` (model-client, 1536d)
- **Bun**: Runtime (1.2+)

## System State

| Metric | Value |
|--------|-------|
| Facts in memory | 5,387 |
| Swarm episodes | 104 |
| Vault files indexed | 345 |
| Wikilinks tracked | 11,506 |

## Architecture

```
packages/rag/
├── src/index.ts              # Type exports
├── scripts/                  # CLI tools (7 scripts)
├── data/rag-config.db        # SQLite config (9 configs)
└── SPEC.md                   # Full technical specification
```

All scripts use `bun:sqlite` for DB access and OpenAI `text-embedding-3-small` (via model-client) for embeddings. No external npm dependencies required.
