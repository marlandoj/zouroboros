#!/usr/bin/env python3.12
"""Export the last N days of memory/activity as a markdown brief for weekly review.

Pulls from:
  - mimir.db facts (synthesized knowledge)
  - shared-facts.db facts + episodes (raw activity)
  - open_loops (in-flight work)
  - scorecard.db (memory system telemetry)

Output: a structured markdown file suitable as a NotebookLM source.

Usage:
    python3.12 brain_dump_export.py                       # Last 7d → stdout
    python3.12 brain_dump_export.py --days 7 --out brief.md
    python3.12 brain_dump_export.py --max-facts 200       # Cap fact count
"""
import argparse
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

MEMORY_DIR = Path("/home/workspace/.zo/memory")

PR_URL_RE = re.compile(r'https://github\.com/[^/]+/[^/]+/pull/\d+$')
ACTION_WORDS = frozenset(["add", "run", "fix", "update", "deploy", "review", "write", "schedule",
                           "audit", "migrate", "archive", "complete", "implement", "test", "verify"])


def rows(db: Path, sql: str, params: tuple = ()) -> list:
    if not db.exists():
        return []
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return list(conn.execute(sql, params))
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def fetch_facts(cutoff: int, max_facts: int) -> tuple[list[dict], dict]:
    out = []
    stats: dict = {"total_raw": 0, "filtered_object": 0, "per_db": {}, "deduped": 0}
    for db_name in ("mimir.db", "shared-facts.db"):
        db = MEMORY_DIR / db_name
        r = rows(
            db,
            "SELECT entity, key, value, category, importance, persona, source, created_at "
            "FROM facts WHERE created_at > ? "
            "ORDER BY importance DESC, created_at DESC LIMIT ?",
            (cutoff, max_facts),
        )
        db_count = 0
        for row in r:
            stats["total_raw"] += 1
            value = (row["value"] or "").strip()
            if not value or "[object Object]" in value or value.lower() in ("undefined", "null", "none"):
                stats["filtered_object"] += 1
                continue
            db_count += 1
            out.append({
                "entity": row["entity"] or "unknown",
                "key": row["key"] or "",
                "value": value,
                "category": row["category"] or "fact",
                "importance": row["importance"] or 0,
                "persona": row["persona"] or "shared",
                "source": row["source"] or db_name,
                "created_at": row["created_at"],
            })
        stats["per_db"][db_name] = db_count
    # Dedup by (entity, key, value)
    seen = set()
    dedup = []
    for f in out:
        k = (f["entity"], f["key"], f["value"][:100])
        if k in seen:
            stats["deduped"] += 1
            continue
        seen.add(k)
        dedup.append(f)
    return dedup, stats


def fetch_episodes(cutoff: int) -> list[dict]:
    out = []
    for db_name in ("mimir.db", "shared-facts.db"):
        db = MEMORY_DIR / db_name
        r = rows(
            db,
            "SELECT id, summary, outcome, happened_at, duration_ms "
            "FROM episodes WHERE happened_at > ? ORDER BY happened_at DESC",
            (cutoff,),
        )
        for row in r:
            out.append({
                "id": row["id"],
                "summary": (row["summary"] or "").strip(),
                "outcome": row["outcome"],
                "happened_at": row["happened_at"],
                "duration_ms": row["duration_ms"],
                "source": db_name,
            })
    return out


NOISE_PATTERNS = (
    "must satisfy",
    "// must",
    "must give",
    "must cause",
    "must retain",
    "must use `tool",
    "must never use touch",
    "must have an `index",
    "must exactly match",
    "must initialize",
    "must be delivered",
    "deprecated api",
    "api endpoints such as",
)


def fetch_open_loops(cutoff: int) -> list[dict]:
    out = []
    for db_name in ("mimir.db", "shared-facts.db"):
        db = MEMORY_DIR / db_name
        r = rows(
            db,
            "SELECT title, summary, kind, priority, persona, created_at "
            "FROM open_loops WHERE status='open' AND created_at > ? "
            "ORDER BY priority DESC, created_at DESC LIMIT 100",
            (cutoff,),
        )
        for row in r:
            title = (row["title"] or "").strip()
            summary = (row["summary"] or "").strip()
            lower = (title + " " + summary).lower()
            if any(p in lower for p in NOISE_PATTERNS):
                continue
            if len(title) < 10 or len(title) > 200:
                continue
            out.append({
                "title": title,
                "summary": summary,
                "kind": row["kind"],
                "priority": row["priority"] or 0,
                "persona": row["persona"] or "shared",
                "created_at": row["created_at"],
            })
    return out


def fetch_telemetry(cutoff: int) -> dict:
    """Scorecard metrics — gate decisions, swarm handoffs, memory stores."""
    db = MEMORY_DIR / "scorecard.db"
    telemetry = {}
    r = rows(db, "SELECT COUNT(*) AS c FROM gate_decisions WHERE created_at > ?", (cutoff,))
    telemetry["gate_decisions"] = r[0]["c"] if r else 0
    r = rows(db, "SELECT COUNT(*) AS c FROM swarm_handoffs WHERE created_at > ?", (cutoff,))
    telemetry["swarm_handoffs"] = r[0]["c"] if r else 0
    r = rows(db, "SELECT COUNT(*) AS c FROM memory_stores WHERE created_at > ?", (cutoff,))
    telemetry["memory_stores"] = r[0]["c"] if r else 0
    return telemetry


def group_by_entity(facts: list[dict]) -> dict[str, list[dict]]:
    grouped = defaultdict(list)
    for f in facts:
        grouped[f["entity"]].append(f)
    return dict(sorted(grouped.items(), key=lambda kv: -len(kv[1])))


def render_markdown(days: int, facts: list[dict], episodes: list[dict],
                    open_loops: list[dict], telemetry: dict, fact_stats: dict = None) -> str:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    lines = []
    lines.append(f"# Weekly Brain Dump — {start.date()} to {end.date()}")
    lines.append("")
    lines.append("Personal knowledge and activity export for weekly review and synthesis.")
    lines.append("")
    lines.append("## Summary")
    lines.append("")

    # Enriched fact count with source breakdown and quality stats
    if fact_stats:
        per_db = fact_stats.get("per_db", {})
        mimir_count = per_db.get("mimir.db", 0)
        shared_count = per_db.get("shared-facts.db", 0)
        filtered = fact_stats.get("filtered_object", 0)
        deduped = fact_stats.get("deduped", 0)
        lines.append(
            f"- **{len(facts)}** facts captured "
            f"({mimir_count} from mimir.db, {shared_count} from shared-facts.db; "
            f"{filtered} low-quality filtered, {deduped} deduped)"
        )
    else:
        lines.append(f"- **{len(facts)}** facts captured")

    # Episode outcome breakdown
    if episodes:
        ep_success = sum(1 for e in episodes if e["outcome"] == "success")
        ep_resolved = sum(1 for e in episodes if e["outcome"] == "resolved")
        ep_failed = sum(1 for e in episodes if e["outcome"] in ("failed", "failure"))
        ep_other = len(episodes) - ep_success - ep_resolved - ep_failed
        parts = []
        if ep_success:
            parts.append(f"{ep_success} success")
        if ep_resolved:
            parts.append(f"{ep_resolved} resolved")
        if ep_failed:
            parts.append(f"{ep_failed} failed")
        if ep_other:
            parts.append(f"{ep_other} other")
        breakdown = f" ({', '.join(parts)})" if parts else ""
        lines.append(f"- **{len(episodes)}** episodes logged{breakdown}")
    else:
        lines.append(f"- **{len(episodes)}** episodes logged")

    lines.append(f"- **{len(open_loops)}** open loops outstanding")
    lines.append(f"- **{telemetry.get('gate_decisions', 0)}** gate decisions")
    lines.append(f"- **{telemetry.get('swarm_handoffs', 0)}** swarm handoffs")
    lines.append(f"- **{telemetry.get('memory_stores', 0)}** memory stores")
    lines.append("")

    if episodes:
        lines.append("## Episodes This Week")
        lines.append("")
        for ep in episodes[:50]:
            ts = datetime.fromtimestamp(ep["happened_at"], tz=timezone.utc).date()
            lines.append(f"- **{ts}** ({ep['outcome']}): {ep['summary']}")
        lines.append("")

    if open_loops:
        lines.append("## Open Loops")
        lines.append("")
        for loop in open_loops[:30]:
            p = f"[p={loop['priority']:.2f}]"
            summary = loop["summary"]
            # Flag vague commitment-type loops that lack a concrete action verb
            vague_flag = ""
            if loop.get("kind") == "commitment":
                lower = (loop["title"] + " " + summary).lower()
                if not any(w in lower for w in ACTION_WORDS):
                    vague_flag = " ⚠️ *[no concrete action word — needs clarification]*"
            lines.append(f"- {p} **{loop['kind']}** — *{loop['title']}* — {summary}{vague_flag}")
        lines.append("")

    grouped = group_by_entity(facts)
    if grouped:
        lines.append("## Facts by Topic")
        lines.append("")
        for entity, items in grouped.items():
            lines.append(f"### {entity}")
            lines.append("")
            for f in items[:5]:
                key = f"**{f['key']}**: " if f["key"] else ""
                value = f["value"]
                # Prompt annotation for bare GitHub PR URLs
                if PR_URL_RE.match(value.strip()):
                    value = f"{value}  *(add one-line description of what this PR does)*"
                lines.append(f"- {key}{value}")
            lines.append("")

    lines.append("## Reflection Prompts for Synthesis")
    lines.append("")
    lines.append("For weekly review and synthesis, analyze the facts and episodes above:")
    lines.append("")
    lines.append("1. Identify the **top 3 themes** with at least one supporting fact or episode per theme.")
    lines.append("2. Call out **patterns** — recurring entity names, unresolved loops older than 1 week, or priority shifts.")
    lines.append("3. Highlight **wins** (episodes with outcome=success and key shipped artifacts) and **blockers** (open loops, failed episodes, or ambiguous commitments).")
    lines.append("4. Surface **cross-project connections** — facts from different entities that share a dependency or risk.")
    lines.append("5. End with **3 specific, actionable recommendations** for the coming week, each naming a concrete next step.")
    lines.append("")
    lines.append("Target tone: direct, concise, like a trusted chief of staff reviewing the week — not promotional.")
    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Brain dump exporter for weekly review")
    parser.add_argument("--days", type=int, default=7, help="Days to look back (default 7)")
    parser.add_argument("--max-facts", type=int, default=300, help="Max facts per DB")
    parser.add_argument("--out", type=str, default=None, help="Output file (default stdout)")
    args = parser.parse_args()

    cutoff = int((datetime.now(timezone.utc) - timedelta(days=args.days)).timestamp())
    facts, fact_stats = fetch_facts(cutoff, args.max_facts)
    episodes = fetch_episodes(cutoff)
    open_loops = fetch_open_loops(cutoff)
    telemetry = fetch_telemetry(cutoff)
    md = render_markdown(args.days, facts, episodes, open_loops, telemetry, fact_stats)

    if args.out:
        Path(args.out).write_text(md)
        print(f"Wrote {len(md)} chars to {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(md)


if __name__ == "__main__":
    main()
