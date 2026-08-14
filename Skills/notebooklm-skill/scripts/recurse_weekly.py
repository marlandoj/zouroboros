#!/usr/bin/env python3.12
"""Weekly Adversarial Debate — orchestrator for the scheduled critique agent.

1. Find the most recent brain-dump-YYYY-MM-DD.md in Documents/BrainDumps
2. Compute next iteration number (counts prior critique files for that draft)
3. Invoke recurse.py to run notebook → debate audio → transcript → objections → mimir
4. Publish artifacts via `zopub sync brain-dumps` so links are shareable
5. Emit a JSON summary on stdout (draft, iteration, counts, top objections, links)

The scheduled agent consumes the JSON and emails the user with the links.

Usage:
    python3.12 recurse_weekly.py                    # Auto-select latest draft
    python3.12 recurse_weekly.py --draft PATH       # Explicit draft
    python3.12 recurse_weekly.py --skip-publish     # Don't run zopub sync
    python3.12 recurse_weekly.py --skip-if-exists   # Bail if iter1 already exists
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
BRAIN_DUMPS = Path("/home/workspace/Documents/BrainDumps")
CRITIQUES = BRAIN_DUMPS / "critiques"
ZOPUB_COLLECTION = "brain-dumps"
ZOPUB_BASE = f"https://zo.pub/marlandoj/{ZOPUB_COLLECTION}"

DRAFT_RE = re.compile(r"^brain-dump-(\d{4}-\d{2}-\d{2})\.md$")


def find_latest_draft() -> Path | None:
    if not BRAIN_DUMPS.exists():
        return None
    candidates = []
    for p in BRAIN_DUMPS.iterdir():
        m = DRAFT_RE.match(p.name)
        if m:
            candidates.append((m.group(1), p))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def next_iteration(draft_stem: str) -> int:
    """Count existing critique files for this draft, return next iter number."""
    if not CRITIQUES.exists():
        return 1
    iters = set()
    for p in CRITIQUES.iterdir():
        m = re.match(rf"^summary-{re.escape(draft_stem)}-iter(\d+)\.json$", p.name)
        if m:
            iters.add(int(m.group(1)))
    return (max(iters) + 1) if iters else 1


def run_recurse(draft: Path, iteration: int) -> dict:
    cmd = [
        "python3.12", str(SCRIPTS / "recurse.py"),
        "--draft", str(draft),
        "--iteration", str(iteration),
    ]
    print(f"[weekly] $ {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        raise SystemExit(f"recurse.py failed with code {result.returncode}")
    summary_path = CRITIQUES / f"summary-{draft.stem}-iter{iteration}.json"
    if not summary_path.exists():
        raise SystemExit(f"Summary missing at {summary_path}")
    return json.loads(summary_path.read_text())


def publish() -> bool:
    try:
        res = subprocess.run(
            ["zopub", "sync", ZOPUB_COLLECTION, str(BRAIN_DUMPS)],
            capture_output=True, text=True, timeout=120,
        )
        if res.returncode != 0:
            print(f"[weekly] zopub failed: {res.stderr}", file=sys.stderr)
            return False
        print(f"[weekly] zopub: {res.stdout.strip()[:200]}", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[weekly] zopub error: {e}", file=sys.stderr)
        return False


def top_objections(objections_path: Path, n: int = 3) -> list[dict]:
    if not objections_path.exists():
        return []
    objs = json.loads(objections_path.read_text())
    objs.sort(key=lambda o: (-int(o.get("severity", 0)), o.get("category", "")))
    return objs[:n]


def build_links(draft: Path, summary: dict, iteration: int) -> dict:
    stem = draft.stem
    return {
        "brief": f"{ZOPUB_BASE}/{stem}.md",
        "critique_audio": f"{ZOPUB_BASE}/critiques/critique-{stem}-iter{iteration}.mp3",
        "transcript": f"{ZOPUB_BASE}/critiques/transcript-{stem}-iter{iteration}.txt",
        "objections": f"{ZOPUB_BASE}/critiques/objections-{stem}-iter{iteration}.json",
        "notebook": (
            f"https://notebooklm.google.com/notebook/{summary['notebook_id']}"
            if summary.get("notebook_id") else None
        ),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", default=None, help="Explicit draft path (default: latest)")
    ap.add_argument("--skip-publish", action="store_true")
    ap.add_argument("--skip-if-exists", action="store_true",
                    help="Exit 0 with reason=already_critiqued if iter1 exists")
    args = ap.parse_args()

    if args.draft:
        draft = Path(args.draft).resolve()
    else:
        draft = find_latest_draft()
    if not draft or not draft.exists():
        print(json.dumps({"ok": False, "error": "no_draft_found"}))
        sys.exit(1)

    iteration = next_iteration(draft.stem)
    if args.skip_if_exists and iteration > 1:
        print(json.dumps({
            "ok": True,
            "skipped": True,
            "reason": "already_critiqued",
            "draft": str(draft),
            "latest_iteration": iteration - 1,
        }))
        return

    summary = run_recurse(draft, iteration)

    published = False
    if not args.skip_publish:
        published = publish()

    objections_file = Path(summary.get("objections_file", ""))
    top = top_objections(objections_file, n=3)
    links = build_links(draft, summary, iteration)

    output = {
        "ok": True,
        "draft": str(draft),
        "iteration": iteration,
        "objection_count": summary.get("objection_count", 0),
        "by_category": summary.get("by_category", {}),
        "by_severity": summary.get("by_severity", {}),
        "mimir_ids": summary.get("mimir_ids", []),
        "notebook_id": summary.get("notebook_id"),
        "published": published,
        "links": links,
        "top_objections": top,
        "artifacts": {
            "audio": summary.get("audio"),
            "transcript": summary.get("transcript"),
            "objections_file": summary.get("objections_file"),
        },
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
