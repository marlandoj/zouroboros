#!/usr/bin/env python3.12
"""Weekly Adversarial Debate — Qdrant edition (no NotebookLM, no audio).

Replaces the NotebookLM two-host audio debate with a written two-host debate
produced by gpt-4o-mini. Keeps the full downstream pipeline: structured
objection extraction, shared-memory persistence, Qdrant archive.

Flow:
  1. Find the latest brain-dump-YYYY-MM-DD.md in Documents/BrainDumps
  2. Compute next iteration number
  3. Ask gpt-4o-mini to write a two-host adversarial debate (Host A steelmans,
     Host B attacks) — saved as transcript-<draft>-iter<N>.txt
  4. Extract objections (structured output) from the written debate
  5. Write objections to shared-facts.db with source=gpt4o-critique
  6. Append debate transcript + objections digest to Qdrant collection
     agent-weekly-adversarial-debate
  7. Emit a JSON summary on stdout (draft, iteration, counts, top objections)

Scheduled agent consumes the JSON and emails the user a summary.

Usage:
    python3.12 recurse_weekly_qdrant.py                    # Auto-select latest draft
    python3.12 recurse_weekly_qdrant.py --draft PATH       # Explicit draft
    python3.12 recurse_weekly_qdrant.py --skip-if-exists   # Bail if iter1 exists
    python3.12 recurse_weekly_qdrant.py --skip-memory      # Skip memory write
    python3.12 recurse_weekly_qdrant.py --skip-qdrant      # Skip Qdrant archive
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
BRAIN_DUMPS = Path("/home/workspace/Documents/BrainDumps")
CRITIQUES = BRAIN_DUMPS / "critiques"
MEMORY_DB_DEFAULT = Path("/home/workspace/.zo/memory/shared-facts.db")
AGENT_SLUG = "weekly-adversarial-debate"
DEBATE_MODEL = "gpt-4o-mini"

DRAFT_RE = re.compile(r"^brain-dump-(\d{4}-\d{2}-\d{2})\.md$")

CRITIQUE_SYSTEM = """You are a two-host adversarial debate panel that also
produces structured objections in a single pass.

Host A (Advocate) steelmans the draft: quotes its strongest claims, explains
why they matter, and notes where evidence is solid.

Host B (Adversary) attacks the draft. Find every weakness:
- Factual errors: claims that are wrong, unsupported, or cite bad data
- Structural gaps: missing steps, logical jumps, undefended assumptions
- Stylistic issues: unclear phrasing, buried leads, hedging
- Adversarial angles: how a hostile reader would misread, weaponize, or dismiss

Do not synthesize. Do not resolve. Reference specific passages from the draft.
Be specific. Be ruthless. Be fair.

After writing the debate, list every concrete objection raised (Host B's
attacks, plus any critiques Host A makes). Each objection must be specific,
tied to a quoted passage, and assigned a category and severity.
"""

CRITIQUE_USER_TEMPLATE = """Draft under review:

<draft>
{draft}
</draft>

Return a single JSON object matching the schema:

1. `transcript`: A back-and-forth debate. Format each turn as `Host A:` or
   `Host B:` followed by the turn content, separated by blank lines. Aim for
   12-20 total turns (6-10 per host). Host B should raise at least 8 distinct,
   concrete objections tied to specific passages. Do not conclude or reconcile
   — end on the final objection.

2. `objections`: An array containing every concrete objection raised in the
   transcript above. Each item: objection (one-sentence summary), category
   (factual | structural | stylistic | adversarial), severity (1-5), quote
   (verbatim passage from the draft being attacked), target (which section,
   claim, or paragraph the objection targets).

The objections array must reflect the transcript — do not invent objections
that were not raised, and do not omit ones that were."""


def find_latest_draft() -> Path | None:
    if not BRAIN_DUMPS.exists():
        return None
    candidates: list[tuple[str, Path]] = []
    for p in BRAIN_DUMPS.iterdir():
        m = DRAFT_RE.match(p.name)
        if m:
            candidates.append((m.group(1), p))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def next_iteration(draft_stem: str) -> int:
    if not CRITIQUES.exists():
        return 1
    iters: set[int] = set()
    for p in CRITIQUES.iterdir():
        m = re.match(rf"^summary-{re.escape(draft_stem)}-iter(\d+)\.json$", p.name)
        if m:
            iters.add(int(m.group(1)))
    return (max(iters) + 1) if iters else 1


def generate_critique(draft: str, openai_client) -> dict:
    """Single-pass critique: transcript + objections in one schema-bound call."""
    print(f"[critique] Calling {DEBATE_MODEL} (single-pass)...", file=sys.stderr)
    start = time.time()

    schema = {
        "type": "object",
        "properties": {
            "transcript": {"type": "string"},
            "objections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "objection": {"type": "string"},
                        "category": {
                            "type": "string",
                            "enum": ["factual", "structural", "stylistic", "adversarial"],
                        },
                        "severity": {"type": "integer", "minimum": 1, "maximum": 5},
                        "quote": {"type": "string"},
                        "target": {"type": "string"},
                    },
                    "required": ["objection", "category", "severity", "quote", "target"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["transcript", "objections"],
        "additionalProperties": False,
    }

    resp = openai_client.chat.completions.create(
        model=DEBATE_MODEL,
        messages=[
            {"role": "system", "content": CRITIQUE_SYSTEM},
            {"role": "user", "content": CRITIQUE_USER_TEMPLATE.format(draft=draft)},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "critique", "strict": True, "schema": schema},
        },
        temperature=0.6,
    )
    elapsed = int(time.time() - start)
    usage = resp.usage
    data = json.loads(resp.choices[0].message.content)
    transcript = data["transcript"]
    objections = data.get("objections", [])
    print(
        f"[critique] {len(transcript)} chars, {len(objections)} objections in {elapsed}s "
        f"(prompt={usage.prompt_tokens}, completion={usage.completion_tokens} tokens)",
        file=sys.stderr,
    )
    return {
        "transcript": transcript,
        "objections": objections,
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
    }


def write_objections_to_memory(
    objections: list[dict],
    db_path: Path,
    draft_path: Path,
    iteration: int,
) -> list[str]:
    now_ms = int(time.time() * 1000)
    draft_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ids: list[str] = []

    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    for idx, obj in enumerate(objections):
        fact_id = str(uuid.uuid4())
        severity_weight = float(obj.get("severity", 3)) / 5.0
        metadata = {
            "draft_path": str(draft_path),
            "draft_date": draft_date,
            "iteration": iteration,
            "source_model": DEBATE_MODEL,
            "category": obj["category"],
            "severity": obj["severity"],
            "host_quote": obj["quote"],
            "target": obj["target"],
        }
        cur.execute(
            """
            INSERT INTO facts (
              id, persona, entity, key, value, text, category, decay_class,
              importance, source, created_at, confidence, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fact_id,
                "shared",
                f"critique.{draft_path.stem}",
                f"{obj['category']}-{idx:02d}",
                obj["objection"],
                obj["objection"],
                "objection",
                "stable",
                severity_weight,
                "gpt4o-critique",
                now_ms,
                0.9,
                json.dumps(metadata),
            ),
        )
        ids.append(fact_id)
    conn.commit()
    conn.close()
    print(f"[memory] Inserted {len(ids)} objections into {db_path}", file=sys.stderr)
    return ids


def append_to_qdrant(week_label: str, draft_stem: str, iteration: int,
                     transcript: str, objections: list[dict]) -> dict:
    sys.path.insert(0, str(SCRIPTS))
    from qdrant_backend import QdrantBackend  # type: ignore

    b = QdrantBackend()
    debate_result = b.add_text(
        AGENT_SLUG,
        title=f"Adversarial Debate — {draft_stem} — iter{iteration}",
        content=transcript,
        tags=["debate", f"draft-{draft_stem}", f"iter-{iteration}"],
    )
    digest_lines = [f"## Objections Digest — {draft_stem} iter{iteration}\n"]
    for idx, o in enumerate(objections):
        digest_lines.append(
            f"{idx+1}. [{o['category']}/sev{o['severity']}] {o['objection']}\n"
            f"   target: {o['target']}\n"
            f"   quote: {o['quote']}\n"
        )
    digest = "\n".join(digest_lines)
    digest_result = b.add_text(
        AGENT_SLUG,
        title=f"Objections Digest — {draft_stem} — iter{iteration}",
        content=digest,
        tags=["digest", f"draft-{draft_stem}", f"iter-{iteration}"],
    )
    return {
        "collection": debate_result["collection"],
        "debate_source_id": debate_result["source_id"],
        "debate_chunks": debate_result["chunks_added"],
        "digest_source_id": digest_result["source_id"],
        "digest_chunks": digest_result["chunks_added"],
    }


def top_objections(objections: list[dict], n: int = 3) -> list[dict]:
    sortable = sorted(
        objections,
        key=lambda o: (-int(o.get("severity", 0)), o.get("category", "")),
    )
    return sortable[:n]


def main():
    ap = argparse.ArgumentParser(description="Weekly Adversarial Debate — Qdrant edition")
    ap.add_argument("--draft", default=None, help="Explicit draft path (default: latest)")
    ap.add_argument("--iteration", type=int, default=None,
                    help="Override iteration (default: auto)")
    ap.add_argument("--skip-if-exists", action="store_true",
                    help="Exit with reason=already_critiqued if iter1 exists")
    ap.add_argument("--skip-memory", action="store_true")
    ap.add_argument("--skip-qdrant", action="store_true")
    ap.add_argument("--memory-db", default=str(MEMORY_DB_DEFAULT))
    ap.add_argument("--output", default=str(CRITIQUES))
    args = ap.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    from openai import OpenAI
    openai_client = OpenAI()

    draft = Path(args.draft).resolve() if args.draft else find_latest_draft()
    if not draft or not draft.exists():
        print(json.dumps({"ok": False, "error": "no_draft_found"}))
        sys.exit(1)

    iteration = args.iteration or next_iteration(draft.stem)
    if args.skip_if_exists and iteration > 1:
        print(json.dumps({
            "ok": True,
            "skipped": True,
            "reason": "already_critiqued",
            "draft": str(draft),
            "latest_iteration": iteration - 1,
        }))
        return

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    draft_text = draft.read_text()
    print(f"[draft] {draft} ({len(draft_text)} chars) — iteration {iteration}", file=sys.stderr)

    critique = generate_critique(draft_text, openai_client)
    transcript = critique["transcript"]
    objections = critique["objections"]

    transcript_path = output_dir / f"transcript-{draft.stem}-iter{iteration}.txt"
    transcript_path.write_text(transcript)
    print(f"[critique] Transcript saved → {transcript_path}", file=sys.stderr)

    objections_path = output_dir / f"objections-{draft.stem}-iter{iteration}.json"
    objections_path.write_text(json.dumps(objections, indent=2))
    print(f"[critique] Objections saved → {objections_path}", file=sys.stderr)

    memory_ids: list[str] = []
    if not args.skip_memory and objections:
        memory_ids = write_objections_to_memory(
            objections, Path(args.memory_db), draft, iteration,
        )

    qdrant_info: dict | None = None
    if not args.skip_qdrant:
        qdrant_info = append_to_qdrant(
            datetime.now(timezone.utc).date().isoformat(),
            draft.stem, iteration, transcript, objections,
        )

    summary = {
        "ok": True,
        "draft": str(draft),
        "iteration": iteration,
        "model": DEBATE_MODEL,
        "transcript": str(transcript_path),
        "objections_file": str(objections_path),
        "objection_count": len(objections),
        "by_category": {
            cat: sum(1 for o in objections if o["category"] == cat)
            for cat in ["factual", "structural", "stylistic", "adversarial"]
        },
        "by_severity": {
            str(s): sum(1 for o in objections if o["severity"] == s)
            for s in range(1, 6)
        },
        "top_objections": top_objections(objections, n=3),
        "memory_ids": memory_ids,
        "qdrant": qdrant_info,
        "debate_tokens": {
            "prompt": critique["prompt_tokens"],
            "completion": critique["completion_tokens"],
        },
    }
    summary_path = output_dir / f"summary-{draft.stem}-iter{iteration}.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
