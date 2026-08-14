#!/usr/bin/env python3.12
"""Weekly Brain Dump — Qdrant edition (no NotebookLM).

1. Export last N days of memory/activity to a markdown brief (brain_dump_export.py)
2. Ask gpt-4o-mini for a "chief of staff" written synthesis (top themes, patterns,
   wins, blockers, recommendations) — replaces the NotebookLM audio overview
3. Append brief + synthesis to Qdrant collection `agent-weekly-brain-dump`
4. Emit a JSON summary on stdout (synthesis text, paths, chunk counts)

The scheduled agent consumes stdout and emails the synthesis to the user.

Usage:
    python3.12 brain_dump_run_qdrant.py              # Default: 7 days
    python3.12 brain_dump_run_qdrant.py --days 14
    python3.12 brain_dump_run_qdrant.py --skip-synthesis --skip-qdrant  # Brief only
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
EXPORT_SCRIPT = SCRIPTS / "brain_dump_export.py"
OUTPUT_DIR = Path("/home/workspace/Documents/BrainDumps")
AGENT_SLUG = "weekly-brain-dump"
SYNTHESIS_MODEL = "gpt-4o-mini"

SYSTEM_PROMPT = (
    "You are a thoughtful chief of staff reviewing a solo founder's weekly "
    "activity, memory, and open loops. Your job is to produce a concise, "
    "actionable written synthesis — the kind of brief you would hand someone "
    "before their Monday planning block."
)

USER_TEMPLATE = """Here is the weekly brain-dump brief (exported from memory and activity logs):

<brief>
{brief}
</brief>

Produce a synthesis with these exact sections (use markdown, no preamble):

## Top 3 Themes
Three one-paragraph themes emerging across facts, episodes, and open loops. Be specific — name projects, decisions, and findings.

## Patterns & Cross-Project Connections
3–5 bullet points. Recurring topics, unresolved loops, priority shifts, connections the user likely hasn't consciously drawn.

## Wins
3–5 bullets. What shipped, what resolved, what measurably improved.

## Blockers
3–5 bullets. What's stuck, why, and what would unblock it.

## Recommendations for Next Week
Exactly 3 numbered recommendations, each one actionable and specific enough to do on Monday morning. Lead each with a verb.

Keep total length under 700 words. Favor specificity over comprehensiveness — if the brief is sparse, say so honestly rather than padding."""


def run_export(brief_path: Path, days: int) -> None:
    result = subprocess.run(
        ["python3.12", str(EXPORT_SCRIPT), "--days", str(days), "--out", str(brief_path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Export failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)


def synthesize(brief: str) -> dict:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model=SYNTHESIS_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_TEMPLATE.format(brief=brief)},
        ],
        temperature=0.4,
    )
    text = resp.choices[0].message.content
    usage = resp.usage
    return {
        "text": text,
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
    }


def append_to_qdrant(week_label: str, brief: str, synthesis_text: str) -> dict:
    sys.path.insert(0, str(SCRIPTS))
    from qdrant_backend import QdrantBackend
    b = QdrantBackend()
    brief_result = b.add_text(
        AGENT_SLUG,
        title=f"Brain Dump Brief — {week_label}",
        content=brief,
        tags=["brief", f"week-{week_label}"],
    )
    synth_result = b.add_text(
        AGENT_SLUG,
        title=f"Brain Dump Synthesis — {week_label}",
        content=synthesis_text,
        tags=["synthesis", f"week-{week_label}"],
    )
    return {
        "collection": brief_result["collection"],
        "brief_source_id": brief_result["source_id"],
        "brief_chunks": brief_result["chunks_added"],
        "synthesis_source_id": synth_result["source_id"],
        "synthesis_chunks": synth_result["chunks_added"],
    }


def main():
    ap = argparse.ArgumentParser(description="Weekly Brain Dump — Qdrant edition")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--skip-synthesis", action="store_true", help="Export only, no LLM")
    ap.add_argument("--skip-qdrant", action="store_true", help="Don't append to Qdrant")
    args = ap.parse_args()

    if not args.skip_synthesis and not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    week_label = datetime.now(timezone.utc).date().isoformat()
    brief_path = OUTPUT_DIR / f"brain-dump-{week_label}.md"

    print(f"[export] Generating {args.days}-day brief → {brief_path}", file=sys.stderr)
    run_export(brief_path, args.days)
    brief = brief_path.read_text()
    print(f"[export] {len(brief)} chars", file=sys.stderr)

    summary: dict = {
        "ok": True,
        "week": week_label,
        "brief_path": str(brief_path),
        "brief_chars": len(brief),
    }

    synthesis_path = None
    synthesis_text = None
    if not args.skip_synthesis:
        print(f"[synthesize] Calling {SYNTHESIS_MODEL}...", file=sys.stderr)
        s = synthesize(brief)
        synthesis_text = s["text"]
        synthesis_path = OUTPUT_DIR / f"brain-dump-{week_label}-synthesis.md"
        synthesis_path.write_text(synthesis_text)
        print(
            f"[synthesize] {len(synthesis_text)} chars "
            f"(prompt={s['prompt_tokens']}, completion={s['completion_tokens']} tokens)",
            file=sys.stderr,
        )
        summary["synthesis_path"] = str(synthesis_path)
        summary["synthesis_text"] = synthesis_text
        summary["synthesis_tokens"] = {
            "prompt": s["prompt_tokens"],
            "completion": s["completion_tokens"],
        }

    if not args.skip_qdrant and synthesis_text is not None:
        print(f"[qdrant] Appending to collection agent-{AGENT_SLUG}", file=sys.stderr)
        q = append_to_qdrant(week_label, brief, synthesis_text)
        summary["qdrant"] = q

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
