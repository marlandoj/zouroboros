---
"zouroboros": major
---

v2.0.0 umbrella release — see CHANGELOG.md for full notes.

Highlights:
- New `zouroboros-rag` package + sage-node DAG
- Swarm decision gate, Hermes watch patterns + SMS alerts, MimirTransport, orchestrate v5 events
- Memory: persona-scoped facts, multi-domain briefings, deep retrieval (LLM reranker, CoT, multi-hop), gpt-4o-mini gate/briefing, OpenAI text-embedding-3-small default, init.ts auto-migrations
- Performance: inline FTS in daemon + Mimir synthesis cache → 40% p50 latency drop
- Selfheal: corrected 5 collector bugs (composite restored to 68%)
- Bun pinned to 1.3.13
