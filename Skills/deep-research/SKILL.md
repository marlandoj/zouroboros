---
name: deep-research
description: >
  Mechanical deep-research pipeline. Chains peer-reviewed literature (Consensus MCP),
  open web (web_research), and the internal Qdrant corpus into a single provenance-tracked
  synthesis, emitted as a markdown report. Use when the user asks to "research X deeply",
  "do a deep dive on X", "what does the research/evidence say about X", or wants a sourced
  report fusing what we already know with what's published. Runs as a resumable, fail-loud,
  file-based DAG: plan -> gather (bounded parallel) -> fuse -> synthesize -> consensus quality gate
  -> one bounded repair if needed -> claim-check -> report -> persist.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# Deep Research Pipeline

A single conductor (`scripts/research.ts`) runs a governed research DAG over capabilities
already integrated in the Zouroboros stack. It uses the pinned Consensus Gate MoA runtime for
generation, the shared model client for embeddings, and file-backed stage artifacts for resume.

## Run it

```bash
bun /home/workspace/Skills/deep-research/scripts/research.ts "<your research question>"
```

Flags:
- `--collections a,b,c` — internal Qdrant collections to search (default: `code-docs,hermes-docs,shared-memory-facts,zouroboros-research`)
- `--no-external` — skip Consensus + web gather (internal corpus only)
- `--no-internal` — skip Qdrant (external lit + web only)
- `--no-compound` — don't persist this run's external sources into the compounding corpus
- `--corpus-collection NAME` — compounding corpus collection (default: `deep-research-corpus`)
- `--raptor-collection NAME` — collection holding RAPTOR L1/L2 summaries (default: `zouroboros-research`)
- `--force` — re-run all stages even if artifacts exist
- `--run-dir <path>` — override output dir
- `--max-papers N` / `--max-web N` — per-sub-question caps (default 6 / 6)
- `--audio` — also render a NotebookLM-style two-host audio overview (`report.mp3`); opt-in (off by default)
- `--audio-minutes N` — target spoken length for the audio overview (default 9)
- `--audio-tts auto|elevenlabs|openai` — TTS backend (default `auto`: ElevenLabs if keyed, else OpenAI)
- `--audio-voices HOST,GUEST` — ElevenLabs voice IDs (default Rachel,Adam)

Output: `/home/workspace/Reports/deep-research/<slug>-<date>/report.md` plus per-stage
artifacts (`00-plan.json`, `01-gather.json`, `02-fused.json`, `03-synthesis.md`, generation and
claim manifests, `04-consensus-attempt-*.json`, `04-validated.json`, `05-compound.json`, and —
with `--audio` — `06-podcast.json` + `report.mp3`).

Treat `run-status.json` as the terminal authority for a run. Surface `report.md` only when its
status is `complete`; a `failed` status may coexist with an older report from a prior pipeline run.

## Architecture (v2)

| Stage | Source | Reachability |
|-------|--------|--------------|
| plan | production MoA lineup (`ZO_MODEL_RESEARCH`, normally `moa:default`) | pinned Consensus Gate MoA runtime |
| gather: lit | `mcp__consensus__search` | `/zo/ask` self-dispatch → file-sentinel |
| gather: web | `mcp__zo__web_research` | `/zo/ask` self-dispatch → file-sentinel |
| gather: internal | Qdrant `127.0.0.1:6333` | direct HTTP (embed + search), skips RAPTOR summary nodes |
| gather: raptor | Qdrant `level≥1` summary nodes | direct HTTP, hierarchical context (v2) |
| gather: community | GraphRAG `community.summary` in `shared-facts.db` | bun:sqlite read + cosine rank (v2) |
| gather: corpus | `deep-research-corpus` Qdrant collection | direct HTTP, prior-run external sources (v2) |
| fuse | deterministic source ranking | direct |
| synthesize / repair | production MoA lineup (`ZO_MODEL_RESEARCH`) | direct MoA runtime with telemetry artifacts |
| quality gate | Consensus Gate | judge mode, author model excluded, fail-closed after at most one repair |
| claim-check / report | Consensus search + deterministic assembly | best-effort claim check; report only after quality pass |
| persist | `Skills/zo-memory-system/scripts/memory.ts` | shelled, soft-fail |
| compound | `deep-research-corpus` Qdrant collection | direct HTTP upsert, idempotent UUID5, soft-fail (v2) |
| audio (opt-in) | production MoA lineup + ElevenLabs/OpenAI TTS + ffmpeg | direct HTTP, Google-NotebookLM-independent, fail-loud (v2) |

Design notes:
- **Governed generation** — all text generation resolves through the pinned production MoA runtime;
  embeddings retain the shared model client, and the conductor never writes a global lineup override.
- **Fail-loud** — a hard stage failure exits non-zero naming the stage; partial artifacts are kept.
- **Idempotent** — each stage skips if its artifact exists; `--force` overrides.
- **Provenance** — every synthesized claim carries an `[S#]` marker resolving to the bibliography.
- **Bounded gather** — at most four external gather calls run concurrently; only transient HTTP
  statuses are retried, for no more than three attempts.
- **Quality promotion** — Consensus Gate is a hard gate. One MoA repair is permitted; a second
  rejection exits at `quality-regate` without publishing a report.
- Consensus free tier caps at 3 results/search, so the separate claim-check remains best-effort.
- **`/zo/ask` gather is file-sentinel self-dispatch** — Consensus + web are agent-level MCP tools a
  plain CLI can't call, so the conductor self-dispatches to this same Zo (`Bearer ZO_API_KEY`); the
  child loads those deferred tools via ToolSearch and writes results to a file on our own
  filesystem, which we read directly. Two hard-won gotchas: (1) **never send `model_name`** in the
  `/zo/ask` body — it blanks the response; (2) **poll for the result file, not the HTTP `output`** —
  long tool-using turns routinely return empty synchronous output.

### v2 internal-knowledge surfaces
Three additional retrieval channels run alongside the leaf-chunk Qdrant search, each auto-skipping
when its data source is absent (so v1 behavior is unchanged on a bare environment):
- **Compounding corpus** — after each run, external sources (Consensus + web) are upserted into a
  persistent `deep-research-corpus` Qdrant collection (idempotent UUID5 ids keyed on url|title, with
  run metadata in the payload). Future runs' `gather: corpus` channel surfaces what we already
  researched, so knowledge accumulates across runs. Disable with `--no-compound`.
- **RAPTOR traversal** — `gather: raptor` pulls the best-matching `level≥1` cluster/corpus summary
  nodes from the RAPTOR hierarchy in `zouroboros-research`, giving the synthesis broad hierarchical
  context. `gather: internal` skips those summary nodes (`level≥1`) to avoid double-counting.
- **GraphRAG communities** — `gather: community` reads Louvain `community.summary` rows from
  `shared-facts.db`, embeds and cosine-ranks them per sub-question (threshold 0.2, top 2).

## Triggering via natural language

In Zo chat, "research X deeply" / "deep dive on X" → run the conductor via Bash and surface
`report.md`. The agent already holds `mcp__consensus__search` and `web_research` directly; the
conductor's `/zo/ask` gather path makes it work headless too (CLI / scheduled agent).

### Audio overview (opt-in, `--audio`)
The original 4th deferred item — a NotebookLM-style "deep dive" audio overview — is **redirected off
Google NotebookLM** (its cookie auth is dead) onto a durable, fully-credentialed path that needs no
new secrets:
1. **Script** — the promoted synthesis (citation markers stripped) is turned into a two-host
   (HOST/GUEST) conversational script through the governed research model. Written to
   `06-podcast.json`.
2. **Voice** — each turn is synthesized to an MP3 segment. Default backend is **ElevenLabs**
   (`eleven_flash_v2_5`, stability 0.85 / style 0 — clean, no chunk-boundary hallucinations), with an
   automatic per-segment fallback to **OpenAI TTS** (`tts-1`, nova/onyx by default) if ElevenLabs is
   unkeyed or fails mid-run. Both TTS model ids are environment-configurable. Segments are written
   to `_audio/seg-NNN.mp3` (segment-level idempotency).
3. **Stitch** — `ffmpeg` concat-demuxer `-c copy` joins the segments into `report.mp3`.

Fail-loud (a hard failure exits non-zero naming the `audio` stage) and idempotent (skips if
`report.mp3` exists; `--force` re-renders). Off by default since TTS costs credits and time.

## v2 status
Shipped 2026-05-31: compounding corpus · RAPTOR query traversal · GraphRAG community summaries ·
audio overview (`--audio`, Google-NotebookLM-independent — redirected from the dead-cookie NotebookLM
path onto OpenAI script + ElevenLabs/OpenAI TTS). All 4 originally-deferred v2 items now shipped.
See `evaluations/seed.yaml`.
