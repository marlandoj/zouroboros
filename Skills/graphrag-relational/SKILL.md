---
name: graphrag-relational
description: |
  Build GraphRAG indexes over relational data by extracting table metadata,
  foreign-key structure, and row-level entities into an embedded FalkorDB graph.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: 0.2.0
  last_updated: 2026-08-11
  graph_store: falkordblite@0.3.0
  decision: adr/0001-graph-store.md
---

# GraphRAG Relational

Use this skill when a task needs to turn relational database structure and rows
into a property graph for retrieval, traversal, or agent context assembly.

## Graph Store

The selected local graph store is **FalkorDB Lite v0.3.0**. The decision is recorded in
[ADR-0001](adr/0001-graph-store.md).

Important operating facts:

- The runtime launches a child Redis 8.2.3 process on a private Unix socket and
  closes it after each index or query operation. It does not provision Docker,
  a TCP listener, or a managed service.
- The official Linux package supplies the pinned FalkorDB module. Its bundled
  Redis binary needs glibc 2.38, so this Debian 12 host builds Redis 8.2.3 from
  the pinned source archive on first use and caches the verified binary.
- Source, module, and cached-binary SHA-256 checks fail closed. A receipt records
  the source URL, versions, digests, and build time without storing credentials.

## Expected Workflow

1. Inspect the relational source schema and record table, column, primary-key,
   and foreign-key evidence.
2. Materialize node labels and relationships in the embedded FalkorDB graph.
3. Load source data in small batches with deterministic IDs derived from source
   table and primary-key values.
4. Query with Cypher for retrieval neighborhoods, provenance paths, and join
   explanations.
5. Keep source database reads separate from graph writes so extraction can be
   replayed from scratch.

## First-Use Runtime

The first index or query downloads and verifies Redis 8.2.3 source, compiles it
with `MALLOC=libc`, and caches it under
`~/.cache/zouroboros/falkordblite/`. Subsequent calls validate the receipt and
binary digest before reuse. The build requires `make`, a C/C++ toolchain, and
network access to GitHub on the first invocation.

An operator can supply a pre-verified executable for an offline environment:

```bash
FALKORDBLITE_REDIS_SERVER=/absolute/path/redis-server \
  bun scripts/index.ts
```
