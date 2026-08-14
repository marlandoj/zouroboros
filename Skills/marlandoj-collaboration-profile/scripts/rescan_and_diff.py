#!/usr/bin/env python3
"""
rescan_and_diff.py — Quarterly collaboration profile drift checker for marlandoj.

Exit codes:
  0 = no drift detected (silent run)
  1 = drift detected (last-diff.md written, email report expected)
  2 = error (archive unreadable or baseline missing)

Usage:
  python3 rescan_and_diff.py              # normal quarterly check
  python3 rescan_and_diff.py --update-baseline  # freeze current scan as new baseline
"""

import sys
import json
import os
import re
import statistics
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta

SKILL_DIR = Path(__file__).parent.parent
BASELINE_FILE = SKILL_DIR / "baseline.json"
LAST_DIFF_FILE = SKILL_DIR / "last-diff.md"
DB_PATH = Path("/home/workspace/.zo/conversations/zo_conversations.duckdb")
STAGING_DIR = Path("/home/workspace/.zo/conversations/_staging")

# Messages with these patterns are automated agent tasks, not hand-typed
AUTOMATED_PATTERNS = [
    r"DELIVERY METHOD:",
    r"COMMUNICATION CHANNEL:",
    r"Agent Purpose Summary",
    r"^\[\"This is file",
    r"^You are now in scheduled_agent_mode",
    r"^\[Session Briefing\]",
    r'^\["USER QUERY:"',
    r'^You are the \w+ persona\.',
    r'^Synthesize the following agent',
    r'^\*\*Email Subject:\*\*',
]

COMPILED_AUTO = [re.compile(p, re.IGNORECASE) for p in AUTOMATED_PATTERNS]


def is_automated(text: str) -> bool:
    if len(text) > 900:
        return True
    for pat in COMPILED_AUTO:
        if pat.search(text[:300]):
            return True
    return False


def extract_text(content_json) -> str | None:
    """Strip JSON encoding and return plain text, or None if not a text message."""
    if isinstance(content_json, list):
        return None  # image/binary payload
    if not isinstance(content_json, str):
        return None
    s = content_json.strip()
    # JSON-encoded string: starts and ends with quote
    if s.startswith('"') and s.endswith('"'):
        try:
            text = json.loads(s)
            if not isinstance(text, str):
                return None
            return text
        except json.JSONDecodeError:
            pass
    return s


def load_staging_messages(since: datetime) -> list[str]:
    """Read unsynced staging JSON payloads and return user prompt texts."""
    texts = []
    if not STAGING_DIR.exists():
        return texts
    for f in STAGING_DIR.glob("duckdb_payload_*.json"):
        try:
            data = json.loads(f.read_text())
            for msg_raw in data.get("messages", []):
                if isinstance(msg_raw, str):
                    try:
                        msg = json.loads(msg_raw)
                    except json.JSONDecodeError:
                        continue
                elif isinstance(msg_raw, dict):
                    msg = msg_raw
                else:
                    continue
                if msg.get("kind") != "request":
                    continue
                ts_str = msg.get("timestamp") or ""
                if ts_str:
                    try:
                        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                        if ts < since:
                            continue
                    except ValueError:
                        pass
                for part in msg.get("parts", []):
                    if not isinstance(part, dict):
                        continue
                    if part.get("part_kind") != "user-prompt":
                        continue
                    text = extract_text(part.get("content_json", ""))
                    if text and not is_automated(text):
                        texts.append(text)
        except Exception:
            continue
    return texts


def load_duckdb_messages(since: datetime | None) -> list[str]:
    """Query DuckDB for user-prompt texts. If since is None, returns all records."""
    try:
        import duckdb
    except ImportError:
        return []
    try:
        con = duckdb.connect(str(DB_PATH), read_only=True)
        if since is not None:
            since_str = since.strftime("%Y-%m-%d %H:%M:%S")
            rows = con.execute("""
                SELECT mp.content_json
                FROM messages m
                JOIN message_parts mp ON m.message_id = mp.message_id
                WHERE m.kind = 'request'
                  AND mp.part_kind = 'user-prompt'
                  AND m.timestamp >= ?
                ORDER BY m.timestamp
            """, [since_str]).fetchall()
        else:
            rows = con.execute("""
                SELECT mp.content_json
                FROM messages m
                JOIN message_parts mp ON m.message_id = mp.message_id
                WHERE m.kind = 'request'
                  AND mp.part_kind = 'user-prompt'
                ORDER BY m.timestamp
            """).fetchall()
        con.close()
        texts = []
        for (cj,) in rows:
            text = extract_text(cj)
            if text and not is_automated(text):
                texts.append(text)
        return texts
    except Exception:
        return []


# Neutral technical feedback words excluded from emotional frustration detection
_NEUTRAL_WORDS = {"wrong", "mistake", "again?", "not working"}


def count_frustration(texts: list[str], words: list[str]) -> int:
    filtered = [w for w in words if w not in _NEUTRAL_WORDS]
    count = 0
    for text in texts:
        lower = text.lower()
        for w in filtered:
            pattern = r'\b' + re.escape(w) + r'\b'
            if re.search(pattern, lower):
                count += 1
                break  # one per message
    return count


def compute_metrics(texts: list[str], baseline: dict) -> dict:
    if not texts:
        return {}
    lengths = [len(t) for t in texts]
    frustration_words = baseline.get("frustration_words", [])
    frust_count = count_frustration(texts, frustration_words)
    return {
        "n_messages": len(texts),
        "median_chars": round(statistics.median(lengths), 1),
        "mean_chars": round(statistics.mean(lengths), 1),
        "p25_chars": round(sorted(lengths)[len(lengths) // 4], 1),
        "p75_chars": round(sorted(lengths)[len(lengths) * 3 // 4], 1),
        "frustration_count": frust_count,
        "frustration_rate": round(frust_count / len(texts), 4),
    }


def detect_drift(current: dict, baseline: dict) -> list[dict]:
    """Return list of drift findings, empty = no drift."""
    findings = []
    agg = baseline.get("aggregate", {})
    thresholds = baseline.get("thresholds", {})

    median_low = thresholds.get("median_chars_low", 50)
    median_high = thresholds.get("median_chars_high", 94)
    frust_max = thresholds.get("frustration_rate_max", 0.005)

    cur_median = current.get("median_chars", 0)
    base_median = agg.get("median_chars", 72)

    if cur_median < median_low:
        findings.append({
            "metric": "median_chars",
            "direction": "down",
            "baseline": base_median,
            "current": cur_median,
            "threshold": median_low,
            "description": f"Median message length dropped to {cur_median}c (baseline {base_median}c, floor {median_low}c) — messages getting unusually terse.",
        })
    elif cur_median > median_high:
        findings.append({
            "metric": "median_chars",
            "direction": "up",
            "baseline": base_median,
            "current": cur_median,
            "threshold": median_high,
            "description": f"Median message length rose to {cur_median}c (baseline {base_median}c, ceiling {median_high}c) — more verbose than established pattern.",
        })

    cur_frust = current.get("frustration_rate", 0)
    cur_frust_count = current.get("frustration_count", 0)
    if cur_frust > frust_max and cur_frust_count >= 2:
        findings.append({
            "metric": "frustration_rate",
            "direction": "up",
            "baseline": 0.0,
            "current": round(cur_frust * 100, 2),
            "threshold": round(frust_max * 100, 2),
            "description": f"Frustration language detected in {round(cur_frust*100,2)}% of messages ({cur_frust_count} messages). Baseline is 0%.",
        })

    return findings


def render_diff_markdown(current: dict, baseline: dict, findings: list[dict], window_desc: str) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    agg = baseline.get("aggregate", {})
    lines = [
        f"# Collaboration Profile Drift Report",
        f"",
        f"**Scan date:** {now}  ",
        f"**Window:** {window_desc}  ",
        f"**Messages scanned:** {current.get('n_messages', 0)}  ",
        f"**Baseline frozen:** {baseline.get('meta', {}).get('frozen_at', 'unknown')} (n={agg.get('n_messages','?')})",
        f"",
        f"## Drift Findings ({len(findings)} flagged)",
        f"",
    ]
    if findings:
        for f in findings:
            lines.append(f"### {f['metric'].replace('_', ' ').title()}")
            lines.append(f"- **Direction:** {f['direction']}")
            lines.append(f"- **Baseline:** {f['baseline']}")
            lines.append(f"- **Current:** {f['current']}")
            lines.append(f"- **Threshold:** {f['threshold']}")
            lines.append(f"- {f['description']}")
            lines.append(f"")
    else:
        lines.append("_No drift detected._")
        lines.append("")

    lines += [
        "## Metrics Comparison",
        "",
        "| Metric | Baseline | Current | Delta |",
        "|--------|----------|---------|-------|",
    ]
    metrics = ["n_messages", "median_chars", "mean_chars", "frustration_rate"]
    labels = ["Messages (n)", "Median chars", "Mean chars", "Frustration rate"]
    for metric, label in zip(metrics, labels):
        base_val = agg.get(metric, "—")
        cur_val = current.get(metric, "—")
        if isinstance(base_val, (int, float)) and isinstance(cur_val, (int, float)):
            delta = round(cur_val - base_val, 2)
            delta_str = f"+{delta}" if delta > 0 else str(delta)
        else:
            delta_str = "—"
        lines.append(f"| {label} | {base_val} | {cur_val} | {delta_str} |")

    lines += [
        "",
        "## Recommended Action",
        "",
        "Review `file 'Notes/marlandoj-collaboration-profile.md'` and decide whether to refresh the baseline:",
        "```",
        "python3 /home/workspace/Skills/marlandoj-collaboration-profile/scripts/rescan_and_diff.py --update-baseline",
        "```",
    ]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--update-baseline", action="store_true", help="Freeze current scan as new baseline")
    parser.add_argument("--window-days", type=int, default=90, help="Scan window in days (default 90)")
    args = parser.parse_args()

    # Load baseline
    if not BASELINE_FILE.exists():
        print(f"ERROR: baseline not found at {BASELINE_FILE}", file=sys.stderr)
        sys.exit(2)
    try:
        baseline = json.loads(BASELINE_FILE.read_text())
    except Exception as e:
        print(f"ERROR: could not parse baseline.json: {e}", file=sys.stderr)
        sys.exit(2)

    since = datetime.now(timezone.utc) - timedelta(days=args.window_days)
    window_desc = f"last {args.window_days} days"

    # Collect messages from primary window
    texts = []
    db_texts = load_duckdb_messages(since)
    texts.extend(db_texts)
    staging_texts = load_staging_messages(since)
    seen = set(db_texts)
    for t in staging_texts:
        if t not in seen:
            texts.append(t)
            seen.add(t)

    # Fallback: if primary window empty, use full DB range
    if not texts:
        print(f"WARNING: no messages in last {args.window_days} days; falling back to full DB range.", file=sys.stderr)
        db_texts = load_duckdb_messages(None)
        staging_texts = load_staging_messages(datetime(2020, 1, 1, tzinfo=timezone.utc))
        seen = set(db_texts)
        texts = list(db_texts)
        for t in staging_texts:
            if t not in seen:
                texts.append(t)
                seen.add(t)
        if texts:
            window_desc = f"full DB history (fallback — no data in last {args.window_days}d window)"
        else:
            print(f"WARNING: no user messages found anywhere. DB may be empty.", file=sys.stderr)
            sys.exit(0)

    if not texts:
        print(f"profile-rescan-90d: no data to compare. Exiting clean.")
        sys.exit(0)

    current = compute_metrics(texts, baseline)

    if args.update_baseline:
        baseline["meta"]["frozen_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        baseline["meta"]["note"] = f"Baseline refreshed via --update-baseline on {baseline['meta']['frozen_at']}"
        baseline["aggregate"] = current
        BASELINE_FILE.write_text(json.dumps(baseline, indent=2))
        print(f"Baseline updated: {current}")
        sys.exit(0)

    findings = detect_drift(current, baseline)

    if not findings:
        print(f"profile-rescan-90d: no drift detected (n={current['n_messages']}, median={current['median_chars']}c, window={window_desc})")
        sys.exit(0)

    # Write diff markdown
    diff_md = render_diff_markdown(current, baseline, findings, window_desc)
    LAST_DIFF_FILE.write_text(diff_md)
    print(diff_md)
    sys.exit(1)


if __name__ == "__main__":
    main()
