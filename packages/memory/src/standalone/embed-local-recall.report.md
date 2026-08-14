# ZOU-420 — Embedding recall comparison

**Mode:** dry-run (deterministic mock, zero spend) · **Fixtures:** `/home/workspace/packages/memory/src/standalone/embed-local-recall.fixtures.json` · **Queries:** 12 · **Corpus:** 40 · **Top-k:** 10 · **Generated:** 2026-08-08T22:27:16.967Z

## Aggregate

| Tier | recall@5 | recall@10 | latency (ms) | cost (USD) |
|------|---------|----------|-------------|-----------|
| **baseline** (text-embedding-3-small) | 14.6% | 27.1% | 17 | $0.000000 |
| **local** (BGE-M3 self-hosted) | 14.6% | 27.8% | 13 | $0.000000 |

**Verdicts:** LOCAL_WINS=3 · BASELINE_WINS=2 · TIE=7 · ERROR=0

## Per-query

| id | query | baseline R@10 | local R@10 | verdict |
|----|-------|-------------|-----------|---------|
| q01 | What embedding model should replace text-embedding-3-small f | 0% | 0% | TIE |
| q02 | How does the bge reranker compare to the LLM listwise rerank | 25% | 50% | LOCAL_WINS |
| q03 | What serves self-hosted embeddings and reranking over HTTP? | 50% | 50% | TIE |
| q04 | How do you reindex a Qdrant collection after changing the em | 0% | 33% | LOCAL_WINS |
| q05 | What is the dormancy contract for opt-in inference tiers? | 50% | 50% | TIE |
| q06 | How does HyDE improve retrieval recall? | 0% | 50% | LOCAL_WINS |
| q07 | How are sparse and dense retrieval fused in hybrid search? | 50% | 0% | BASELINE_WINS |
| q08 | What is the standard benchmark for evaluating embedding mode | 0% | 0% | TIE |
| q09 | How does the consensus gate decide before promoting a fact? | 50% | 50% | TIE |
| q10 | What does the deep-research skill synthesize? | 0% | 0% | TIE |
| q11 | Why is a self-hosted embedding service cheaper than the API? | 50% | 0% | BASELINE_WINS |
| q12 | What metric measures the fraction of relevant docs in the to | 50% | 50% | TIE |

> Dry-run uses tier-salted deterministic mock embeddings for both tiers (zero API spend). Per-tier recall@k differs due to the salt perturbation, which exercises the verdict logic and proves the harness captures tier differences — the magnitude is a mock artifact, NOT a model-quality signal. The live run (--live, requires OPENAI_API_KEY + ZO_EMBED_BASE_URL) measures the true recall delta of BGE-M3 vs text-embedding-3-small; live GPU provisioning is deferred to the Hetzner annex (ZOU-414).
