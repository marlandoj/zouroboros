---
name: rag-telemetry
description: Emit and validate a shared operational telemetry contract for Vector RAG, GraphRAG query, and GraphRAG indexing workflows. Use when instrumenting retrieval operations or maintaining the unified RAG telemetry dashboard.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: 0.1.0
---

# RAG Telemetry

Use `scripts/telemetry.ts` to append privacy-bounded, versioned retrieval events
to the shared JSONL sink. Query text and error messages are truncated, while
Cypher and retrieved content must never be included in event details.

The default sink is `/dev/shm/rag-telemetry.jsonl`. Override it with
`RAG_TELEMETRY_PATH` for tests or alternate runtimes.
