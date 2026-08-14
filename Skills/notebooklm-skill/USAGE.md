# Natural-language usage — Artem NotebookLM adoptions

Reference for invoking the four adoptions from Zo chat (or any Claude session). Phrase examples → script translation. All scripts live under `scripts/`.

Prereqs: `OPENAI_API_KEY` in `/root/.zo_secrets`, Qdrant on `127.0.0.1:6333`. Source secrets first when running from an agent: `source /root/.zo_secrets && …`.

---

## Adoption 2 — Bulk YouTube ingest into an agent's brain

**Say:**
- "Ingest the Anthropic YouTube channel into my `claude-research` agent."
- "Pull the last 50 videos from `https://youtube.com/@anthropic-ai/videos` into agent `claude-research`."
- "Add `https://youtube.com/@somechannel` to the `aventurine` agent's research."

**Runs:**
```bash
python3.12 scripts/nlm.py load-channel <url> --qdrant --slug <agent>
```

**Behavior:** auto-creates `agent-<slug>` Qdrant collection if missing. Ingests metadata for every video; full transcripts upgrade to `[T]` markers when YouTube isn't IP-blocking, else `[m]` metadata-only. Default cap 250 videos — pass `--limit N` to change.

**Search alone (no ingest):**
- "Search YouTube for `agentic coding tutorials`, top 5 results."
- Runs: `nlm.py search "agentic coding tutorials" --limit 5` (returns JSON; no ingest).

---

## Adoption 4 — Topics-as-hubs (query an agent's brain)

**Say (list hubs):**
- "What topics has my `claude-research` agent collected?"
- "Show me the topic hubs for agent `aventurine`."

**Runs:** `python3.12 scripts/agent_research.py topics <slug>`

**Say (drill into a hub):**
- "Show the facts under the `claude-code` hub for `claude-research`."
- "What's in the `funnel` topic for the `aventurine` agent?"

**Runs:** `python3.12 scripts/agent_research.py topic <slug> <topic-slug>`

**Say (ask the agent):**
- "Ask my `claude-research` agent: what videos discuss agentic coding?"
- "Query the `aventurine` agent about copywriting frameworks."

**Runs:**
```bash
python3.12 scripts/agent_research.py ask <slug> \
  --question "…" --backend qdrant
```

**Behavior:** retrieves top-k chunks from `agent-<slug>`, synthesizes a grounded answer with bracket citations, auto-extracts 3-7 topic hubs, persists `fact_citations` and `fact_topics` rows to `mimir.db` (gated to skip near-duplicates).

---

## Adoption 3 — One Thing synthesis (PKA briefings)

**Say:**
- "Run a session briefing for the Mimir persona."
- "What's the one thing I should focus on for FFB today?"
- "Brief me as Aventurine."

**Runs:** `bun /home/workspace/Skills/zo-memory-system/scripts/session-briefing.ts --persona <persona>`

**Behavior:** synthesizes the last 24h of memory into a single highest-value action ("the one thing"). Cross-persona promotion enabled — facts from another persona surface if relevant. Tier 0 memory-gate skip in effect (no redundant lookups for the briefing itself).

Already runs on schedule for active personas via the daily PKA agent — only call manually for ad-hoc reads.

---

## Adoption 1 — Citation provenance (dormant)

Only fires when querying via NotebookLM (`nlm.py ask <notebook> "…"`), and the auth path is dead on Zo (Google revokes Playwright sessions in ~2h). The 75 already-persisted `fact_citations` remain queryable in `mimir.db`.

**Say (inspect existing):**
- "Show citations for fact `<fact_id>` in mimir."
- "What chunks back fact `qa:abc123:2`?"

**Runs:** SQL against `mimir.db`:
```sql
SELECT sc.title, sc.cited_text, fc.chunk_md5
FROM fact_citations fc
JOIN source_chunks sc ON sc.chunk_md5 = fc.chunk_md5
WHERE fc.fact_id = '<fact_id>';
```

To re-enable live: open Chrome → notebooklm.google.com → Cookie-Editor extension Export → reply with the JSON. Resets the auth window for ~hours of manual Q&A.

---

## Storage layout (for the curious)

- `shared-facts.db` at `/home/workspace/.zo/memory/shared-facts.db` — `source_chunks`, `fact_citations`, `topics`, `fact_topics`
- Qdrant collections at `127.0.0.1:6333` named `agent-<slug>` — 1536-dim cosine, 800-token chunks
- Schema: `Skills/zo-memory-system/scripts/schema.sql`
