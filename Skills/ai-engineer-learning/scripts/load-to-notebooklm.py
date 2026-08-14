#!/usr/bin/env python3.12
"""
AI Engineer Learning — Bulk-add remaining videos to NotebookLM.

Assigns videos to notebooks by their absolute position in channel-videos.txt
(positions 0-249 → notebook 1, 250-499 → notebook 2, etc.) so resuming after
interruption never overflows a notebook or duplicates work.

Prerequisites:
  - Valid NotebookLM session (run: python3.12 nlm.py import-cookies cookies.json)
  - python3.12 (notebooklm-py installed there)

Usage:
  python3.12 load-to-notebooklm.py              # create notebooks + add all URLs
  python3.12 load-to-notebooklm.py --dry-run   # preview only
"""
import asyncio, json, sys, time
from pathlib import Path

NLM_SCRIPTS = Path("/home/workspace/Skills/notebooklm-skill/scripts")
PROJECT_DIR = Path("/home/workspace/Projects/ai-engineer-learning")
VIDEOS_FILE = PROJECT_DIR / "channel-videos.txt"
NLM_MAP     = PROJECT_DIR / "notebooklm-notebooks.json"
NLM_STATE   = PROJECT_DIR / "notebooklm-loaded.json"

sys.path.insert(0, str(NLM_SCRIPTS))

BATCH_SIZE  = 250   # stay under 300-source limit with buffer
CONCURRENCY = 5     # parallel add_url calls per notebook


def get_all_videos():
    lines = VIDEOS_FILE.read_text().splitlines()
    videos = []
    for line in lines:
        parts = line.split("|")
        if len(parts) >= 4:
            videos.append({
                "id":    parts[0].strip(),
                "title": parts[1].strip(),
                "url":   parts[3].strip(),
            })
    return videos


def load_state():
    return set(json.loads(NLM_STATE.read_text()) if NLM_STATE.exists() else [])


def save_state(nlm_loaded: set):
    NLM_STATE.write_text(json.dumps(sorted(nlm_loaded), indent=2))


async def load_batch_to_notebook(client, notebook_id: str, videos: list, dry_run: bool, nlm_loaded: set):
    sem = asyncio.Semaphore(CONCURRENCY)
    added = 0
    failed = 0

    async def _add(v):
        nonlocal added, failed
        async with sem:
            if dry_run:
                print(f"  [dry-run] would add: {v['title'][:60]}")
                return
            try:
                await client.sources.add_url(notebook_id, v["url"])
                added += 1
                nlm_loaded.add(v["id"])
                save_state(nlm_loaded)
                print(f"  ✓ {v['title'][:70]}")
            except Exception as e:
                failed += 1
                print(f"  ✗ {v['title'][:70]} — {str(e)[:80]}")

    await asyncio.gather(*(_add(v) for v in videos))
    return added, failed


async def main():
    dry_run = "--dry-run" in sys.argv

    from nlm import get_client

    all_videos  = get_all_videos()
    nlm_loaded  = load_state()

    # Assign each video to a notebook by its position in the channel list.
    # This is stable across restarts: video at position i always goes to notebook (i // BATCH_SIZE + 1).
    nb_assignments: dict[str, list] = {}
    for i, v in enumerate(all_videos):
        if v["id"] not in nlm_loaded:
            nb_key = f"ai-engineer-{i // BATCH_SIZE + 1}"
            nb_assignments.setdefault(nb_key, []).append(v)

    remaining_total = sum(len(vs) for vs in nb_assignments.values())
    print(f"AI Engineer Learning — NotebookLM Bulk Loader")
    print(f"  Total videos      : {len(all_videos)}")
    print(f"  Already loaded    : {len(nlm_loaded)}")
    print(f"  Remaining         : {remaining_total}")
    print(f"  dry-run           : {dry_run}")
    print()

    if not remaining_total:
        print("Nothing to load."); return

    nb_map = json.loads(NLM_MAP.read_text()) if NLM_MAP.exists() else {}

    print(f"Notebooks to update ({len(nb_assignments)}):")
    for nb_key, videos in sorted(nb_assignments.items()):
        status = f"existing: {nb_map[nb_key]['id']}" if nb_key in nb_map else "will create"
        print(f"  {nb_key}: {len(videos)} videos to add ({status})")
    print()

    client = await get_client()
    try:
        for nb_key, videos in sorted(nb_assignments.items()):
            nb_num  = nb_key.split("-")[-1]
            nb_name = f"AI Engineer Learning #{nb_num}"

            if nb_key in nb_map:
                nb_id = nb_map[nb_key]["id"]
                print(f"\n=== {nb_name} (existing: {nb_id}) — {len(videos)} to add ===")
            else:
                print(f"\n=== {nb_name} (creating...) — {len(videos)} to add ===")
                if not dry_run:
                    nb = await client.notebooks.create(nb_name)
                    nb_id = nb.id
                    nb_map[nb_key] = {"id": nb_id, "name": nb_name, "video_count": 0}
                    NLM_MAP.write_text(json.dumps(nb_map, indent=2))
                    print(f"  Created: {nb_id}")
                else:
                    nb_id = f"dry-run-{nb_num}"
                    print(f"  [dry-run] would create notebook")

            t0 = time.time()
            added, failed = await load_batch_to_notebook(client, nb_id, videos, dry_run, nlm_loaded)
            elapsed = time.time() - t0

            if not dry_run:
                nb_map[nb_key]["video_count"] = nb_map[nb_key].get("video_count", 0) + added
                nb_map[nb_key]["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ")
                NLM_MAP.write_text(json.dumps(nb_map, indent=2))

            print(f"\n  {nb_key} done in {elapsed:.0f}s: {added} added, {failed} failed")

    finally:
        await client.__aexit__(None, None, None)

    print(f"\n✓ NotebookLM loading complete")
    print(f"  Notebooks saved to: {NLM_MAP}")
    if not dry_run:
        print(f"\nQuery with:")
        for key, info in sorted(nb_map.items()):
            print(f"  python3.12 nlm.py ask --notebook {info['id']} --question \"your question\"")


if __name__ == "__main__":
    asyncio.run(main())
