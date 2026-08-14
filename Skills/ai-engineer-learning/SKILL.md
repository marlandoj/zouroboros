---
name: ai-engineer-learning
description: YouTube transcript ingestion pipeline and RAG query interface for the AI Engineer persona. Refreshes the @aiDotEngineer catalog, preserves metadata coverage, and upgrades queued videos with transcripts. Run weekly to stay current.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# AI Engineer Learning Skill

Consumes, indexes, and queries the entire [@aiDotEngineer](https://www.youtube.com/@aiDotEngineer) YouTube channel — a leading source of AI engineering talks from Google DeepMind, Anthropic, OpenAI, Hugging Face, and more.

## Current Status (2026-07-20)

- **892 unique channel videos** represented in Qdrant
- New videos receive metadata embeddings immediately, even when YouTube blocks direct caption APIs
- Transcript upgrades use Zo `read_webpage` and a bounded queue at `Projects/ai-engineer-learning/pending-transcripts.json`
- Collection: `ai-engineer-videos` @ `127.0.0.1:6333`

## When to Use

- The **AI Engineer** persona is working on Zouroboros and needs current best practices
- Building agents, RAG systems, evals, MCP servers, or AI infrastructure
- Need to reference talks on: agent architecture, context management, evaluation, MCP, RAG, model deployment, voice AI, multi-agent systems, observability
- Weekly: run the update pipeline to ingest new videos

## Query the Knowledge Base

```bash
# Semantic search (primary interface)
bun Skills/ai-engineer-learning/scripts/query.ts "how to build durable agents"
bun Skills/ai-engineer-learning/scripts/query.ts "context management" --top 10
bun Skills/ai-engineer-learning/scripts/query.ts "evaluation frameworks"

# Within AI Engineer persona, this is the first thing to call before suggesting approaches
```

## Ingestion Pipeline

### Add New Videos (weekly sync)
```bash
# 1. Refresh the live channel catalog and queue newly discovered videos
bun Skills/ai-engineer-learning/scripts/ingest-youtube.ts --phase discover

# 2. Index any catalog videos missing from Qdrant
python3 Skills/ai-engineer-learning/scripts/ingest-metadata.py

# 3. Use Zo read_webpage for a bounded batch from pending-transcripts.json,
#    copy each saved markdown file to Articles/<video-id> :: www.youtube.com.md,
#    then upgrade metadata points to transcript chunks.
bun Skills/ai-engineer-learning/scripts/process-transcripts.ts

# 4. Prove every catalog ID is represented and Qdrant is green
bun Skills/ai-engineer-learning/scripts/audit-index.ts
```

### Upgrade Metadata → Transcript (when articles are available)
```bash
# Videos saved via Zo's save_webpage land in /home/workspace/Articles/
# as "* :: www.youtube.com.md" files. Run this to embed them:
bun Skills/ai-engineer-learning/scripts/process-transcripts.ts
```

### NotebookLM Path (richer knowledge, needs Google session)

Use this for natural language deep-dives on topics. Requires valid NotebookLM cookies.

```bash
# Check session status
cd /home/workspace/Skills/notebooklm-skill/scripts
python3.12 nlm.py status

# If expired — re-export cookies (90-second process):
#   1. Open notebooklm.google.com in Chrome (must be signed in)
#   2. Install Cookie-Editor extension, click Export, copy JSON
#   3. Paste to /tmp/cookies.json on Zo
#   4. python3.12 nlm.py import-cookies /tmp/cookies.json

# Bulk-add remaining 535 videos to 2 NotebookLM notebooks (one-shot after auth):
python3.12 /home/workspace/Skills/ai-engineer-learning/scripts/load-to-notebooklm.py

# Query NotebookLM knowledge base:
python3.12 nlm.py ask --notebook <nb_id> --question "best practices for agent memory"
# (Notebook IDs saved to Projects/ai-engineer-learning/notebooklm-notebooks.json after load)
```

## Files

- `scripts/ingest-youtube.ts` — Live catalog refresh, pending queue, and diagnostic direct-caption path
- `scripts/fetch-transcript.py` — Structured direct-caption diagnostics with provider-block detection
- `scripts/ingest-metadata.py` — Repairs missing metadata coverage with deterministic point IDs
- `scripts/ingest-batch.py` — Full transcript Qdrant indexer (requires residential IP / save_webpage)
- `scripts/process-transcripts.ts` — Embeds Articles markdown with deterministic IDs and removes replaced metadata points
- `scripts/audit-index.ts` — Fails closed on missing, unexpected, or unhealthy Qdrant state
- `scripts/load-to-notebooklm.py` — Bulk-add YouTube URLs to NotebookLM notebooks
- `scripts/query.ts` — Semantic search + research notebook generator
- `Projects/ai-engineer-learning/channel-videos.txt` — Video metadata catalog (763 videos)
- `Projects/ai-engineer-learning/processed.json` — State file (tracks ingested videos)
- `Projects/ai-engineer-learning/notebooklm-notebooks.json` — NotebookLM notebook IDs (after load)

## Scheduled Agent

Weekly agent `[ZBR] Ingest AI Engineer Videos` runs every Monday at 2:00 AM America/Phoenix:
```bash
bun Skills/ai-engineer-learning/scripts/ingest-youtube.ts --phase discover
python3 Skills/ai-engineer-learning/scripts/ingest-metadata.py
bun Skills/ai-engineer-learning/scripts/process-transcripts.ts
bun Skills/ai-engineer-learning/scripts/audit-index.ts
```
The automation uses Zo `read_webpage` for up to 12 queued transcripts per run between metadata indexing and transcript processing.
