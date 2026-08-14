# Local embedding + reranker tier (ZOU-420)

A self-hosted **embedding** tier (BGE-M3 or NV-Embed-v2) and **reranker** tier
(bge-reranker-v2), served by HuggingFace [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) (TEI) or
[Infinity](https://github.com/michaelfeil/Infinity) on the Hetzner GPU annex
(ZOU-414) and reached over HTTP, layered into the existing Qdrant RAG pipeline
as **dormant-until-armed drop-ins**. With the env vars unset, `embeddings()` and
`rerank()` are byte-identical to the pre-ZOU-420 defaults (OpenAI
`text-embedding-3-small` and RankGPT `gpt-4o-mini`); activation is a one-env-var
flip per tier.

This mirrors the ZOU-421 local-inference precedent: the host sandbox has no GPU,
so the **live GPU run** (real BGE-M3/bge-reranker-v2 inference, real Qdrant
reindex, true recall measurement) is **deferred to the provisioned annex** and
recorded honestly — not silently closed. The in-sandbox deliverable is the client
sockets, health probes, a live-capable Qdrant reindex entry point, a
live-capable recall@k comparison harness, tests, and this doc.

## Sockets

| Tier | Socket | Endpoint | Default model | Armed by |
|------|--------|----------|---------------|----------|
| Embedding | `localEmbeddings()` in `packages/memory/src/standalone/model-client.ts` | `<base>/v1/embeddings` (OpenAI-compatible) | `bge-m3` (1024-d) | `ZO_EMBED_BASE_URL` |
| Reranker | `rerankLocal()` in `packages/rag/scripts/rag-pipeline.ts` | `<base>/rerank` (TEI/Infinity) | `bge-reranker-v2` | `ZO_RERANK_BASE_URL` |

Both sockets: optional bearer (`ZO_EMBED_API_KEY` / `ZO_RERANK_API_KEY`), one
retry, 60s timeout, fall back gracefully (the reranker returns input order on
any error — never worse than retrieval). `embeddings()` short-circuits to
`localEmbeddings()` when armed; `rerank()` short-circuits to `rerankLocal()` when
armed — no new `Provider` enum value, so the exhaustive switches and ~16
importers of `model-client.ts` are unaffected.

## Configuration

```bash
# Embedding tier (arm to drop BGE-M3 into the Qdrant RAG embed path)
export ZO_EMBED_BASE_URL="http://hetzner-gpu:8080"   # REQUIRED to arm
export ZO_EMBED_MODEL="bge-m3"                        # default bge-m3
export ZO_EMBED_API_KEY=""                            # optional bearer
export ZO_EMBED_DIM="1024"                            # default 1024 (BGE-M3)
export ZO_EMBED_USD_PER_1K="0"                        # amortized cost; 0 = free-at-API

# Reranker tier (arm to drop bge-reranker-v2 into the Qdrant RAG rerank path)
export ZO_RERANK_BASE_URL="http://hetzner-gpu:8081"  # REQUIRED to arm
export ZO_RERANK_MODEL="bge-reranker-v2"              # default bge-reranker-v2
export ZO_RERANK_API_KEY=""                           # optional bearer
```

Leaving `ZO_EMBED_BASE_URL` / `ZO_RERANK_BASE_URL` unset leaves the pipeline
byte-identical to the OpenAI/RankGPT default — verified by tests.

## Health probes

```bash
bun -e 'import("./packages/memory/src/standalone/model-client").then(async m => console.log(await m.localEmbedHealthCheck()))'
bun -e 'import("./packages/rag/scripts/rag-pipeline").then(async m => console.log(await m.rerankLocalHealthCheck()))'
```

## Reindexing a Qdrant collection

`packages/memory/src/standalone/embed-reindex.ts` recreates a target collection
at the local model's dim and re-ingests a source collection's docs.

```bash
# Mechanical dry-run (default): proves create → embed-batch → upsert → count
# with a deterministic local mock and ZERO Qdrant mutation.
bun packages/memory/src/standalone/embed-reindex.ts --dry-run

# Live: real Qdrant + real localEmbeddings(). Requires ZO_EMBED_BASE_URL + QDRANT_URL.
bun packages/memory/src/standalone/embed-reindex.ts --live \
  --source hermes-docs --target hermes-docs_bge --dim 1024 --batch 64
```

## Recall comparison vs text-embedding-3-small

`packages/memory/src/standalone/embed-local-recall.ts` compares the OpenAI
`text-embedding-3-small` baseline against the self-hosted local tier over a fixed
fixture set (12 queries × ~40 docs).

```bash
# Mechanical dry-run (default): tier-salted deterministic mock, zero spend.
bun packages/memory/src/standalone/embed-local-recall.ts --dry-run --out ./reports

# Live: OpenAI baseline (called directly) vs localEmbeddings() (BGE-M3).
# Requires OPENAI_API_KEY + ZO_EMBED_BASE_URL.
bun packages/memory/src/standalone/embed-local-recall.ts --live --out ./reports
```

Emits `embed-local-recall.report.md` + `.json`: per-query recall@5/recall@10 for
both tiers, aggregate recall, latency, cost, and a per-query verdict
(`LOCAL_WINS` / `BASELINE_WINS` / `TIE` / `ERROR`).

### Methodology

- **Baseline**: OpenAI `text-embedding-3-small`, called directly so the harness
  measures the exact model being replaced, independent of the dormant-until-armed
  short-circuit.
- **Local**: `localEmbeddings()` via `ZO_EMBED_BASE_URL` (BGE-M3), exercising the
  same production dispatch path the `qdrant-rag` MCP uses.
- **Fair comparison**: the corpus is embedded with each tier's own model and
  ranked by cosine similarity to the (same-tier) embedded query; recall@k is the
  fraction of the ground-truth `relevantDocIds` in the top-k.
- **Dry-run**: uses tier-salted deterministic mock embeddings (SHA-256-derived).
  Per-tier recall@k differs due to the salt perturbation, which exercises the
  verdict logic and proves the harness captures tier differences — the magnitude
  is a mock artifact, **not** a model-quality signal.
- **Live**: real embeddings; the aggregate recall@k is the true recall comparison.
  True SWE-bench-style IR benchmarks (BEIR/MTEB over the live corpus) are a
  follow-up on the annex; the harness fixtures are the in-sandbox proxy.

## Deferred (live) — ZOU-414 annex

The following are **deferred** to the provisioned Hetzner GPU annex, not
silently closed:

- Live BGE-M3 / NV-Embed-v2 / bge-reranker-v2 inference (no GPU in the sandbox).
- Real Qdrant collection reindex over the production corpus (`--live`).
- True recall@k measurement over the live corpus (the dry-run proves the harness;
  `--live` measures the real delta once the annex is provisioned).
- NV-Embed-v2 variant (BGE-M3 is the default; NV-Embed-v2 is a one-env-var model
  swap: `ZO_EMBED_MODEL=nvidia/NV-Embed-v2`, `ZO_EMBED_DIM=4096`).

Activation is a one-env-var flip per tier — no code change required.
