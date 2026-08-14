#!/usr/bin/env python3
"""
AI Engineer Learning — Fast batch ingestion via youtube-transcript-api.

Reads all 763 video IDs from channel-videos.txt, fetches transcripts directly
(no browser), chunks, embeds with text-embedding-3-small, and upserts to Qdrant.

Usage:
  python ingest-batch.py                   # process all remaining
  python ingest-batch.py --limit 50        # first 50 unprocessed
  python ingest-batch.py --concurrency 4   # parallel embed calls (default 4)
  python ingest-batch.py --dry-run         # transcript fetch only, no embed/upsert
"""
import json, os, sys, time, hashlib, asyncio, re
from pathlib import Path

# Self-heal secrets
secrets_path = os.environ.get("ZO_SECRETS_PATH", "/root/.zo_secrets")
if not os.environ.get("OPENAI_API_KEY"):
    try:
        for line in Path(secrets_path).read_text().splitlines():
            m = re.match(r'^export\s+(\w+)=["\']?([^"\']*)["\']?$', line.strip())
            if m:
                os.environ.setdefault(m.group(1), m.group(2))
    except Exception:
        pass

from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
import urllib.request

QDRANT_URL  = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333").rstrip("/")
COLLECTION  = "ai-engineer-videos"
VECTOR_SIZE = 1536
CHUNK_CHARS = 2000
CHUNK_OVERLAP = 300

PROJECT_DIR   = Path("/home/workspace/Projects/ai-engineer-learning")
VIDEOS_FILE   = PROJECT_DIR / "channel-videos.txt"
STATE_FILE    = PROJECT_DIR / "processed.json"
OPENAI_KEY    = os.environ.get("OPENAI_API_KEY") or os.environ.get("ZO_OPENAI_API_KEY", "")


# ── State ────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"processed": {}}

def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── Qdrant ───────────────────────────────────────────────────────────────────

def q_req(method: str, path: str, body=None):
    url = f"{QDRANT_URL}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def ensure_collection():
    try:
        q_req("GET", f"/collections/{COLLECTION}")
        print(f"  collection '{COLLECTION}' exists, reusing.")
    except Exception:
        q_req("PUT", f"/collections/{COLLECTION}", {
            "vectors": {"size": VECTOR_SIZE, "distance": "Cosine"},
            "on_disk_payload": True,
        })
        print(f"  collection '{COLLECTION}' created.")


# ── Chunking ─────────────────────────────────────────────────────────────────

def chunk_text(text: str, chars=CHUNK_CHARS, overlap=CHUNK_OVERLAP) -> list[str]:
    if len(text) <= chars:
        return [text]
    advance = max(1, chars - overlap)
    return [text[i:i+chars] for i in range(0, len(text), advance)]


# ── OpenAI embeddings ────────────────────────────────────────────────────────

def embed_texts(texts: list[str]) -> list[list[float]]:
    """Batch embed up to 100 texts in one API call."""
    if not texts:
        return []
    payload = json.dumps({"input": texts, "model": "text-embedding-3-small"}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_KEY}",
        }
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    return [item["embedding"] for item in data["data"]]


# ── Qdrant upsert ─────────────────────────────────────────────────────────────

# Monotonic point ID counter persisted across videos in a run
_next_id = 1

def get_max_point_id() -> int:
    """Get the current highest point ID in the collection."""
    try:
        result = q_req("POST", f"/collections/{COLLECTION}/points/scroll", {
            "limit": 1, "with_payload": False, "with_vector": False,
            "order_by": {"key": "id", "direction": "desc"}
        })
        pts = result.get("result", {}).get("points", [])
        if pts:
            return pts[0]["id"] + 1
    except Exception:
        pass
    return 1

def upsert_points(points: list[dict]):
    if not points:
        return
    try:
        q_req("PUT", f"/collections/{COLLECTION}/points?wait=true", {"points": points})
    except Exception:
        kept = 0
        for p in points:
            try:
                q_req("PUT", f"/collections/{COLLECTION}/points?wait=true", {"points": [p]})
                kept += 1
            except Exception as e:
                print(f"\n  drop id={p['id']}: {str(e)[:80]}")
        if kept < len(points):
            print(f"  ({kept}/{len(points)} kept)")


# ── Transcript fetch ──────────────────────────────────────────────────────────

def fetch_transcript(video_id: str) -> str | None:
    """Fetch transcript text using youtube-transcript-api (v1.2.4 instance API)."""
    try:
        api = YouTubeTranscriptApi()
        # Try fetching English directly (handles auto-generated too)
        try:
            entries = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        except Exception:
            # Fall back to any available language
            transcript_list = api.list(video_id)
            transcript = next(iter(transcript_list))
            entries = transcript.fetch()

        chunks = []
        for entry in entries:
            t = int(getattr(entry, "start", 0) if hasattr(entry, "start") else entry.get("start", 0))
            mm, ss = divmod(t, 60)
            text = (getattr(entry, "text", "") if hasattr(entry, "text") else entry.get("text", "")).replace("\n", " ").strip()
            if text:
                chunks.append(f"[{mm}:{ss:02d}] {text}")
        return "\n".join(chunks) if chunks else None

    except (NoTranscriptFound, TranscriptsDisabled):
        return None
    except Exception as e:
        print(f"\n  transcript error {video_id}: {str(e)[:80]}")
        return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global _next_id

    limit    = None
    dry_run  = "--dry-run" in sys.argv
    for arg in sys.argv[1:]:
        if arg.startswith("--limit="):
            limit = int(arg.split("=")[1])

    print("AI Engineer Learning — Batch Ingestion (youtube-transcript-api)")
    print(f"  collection : {COLLECTION}")
    print(f"  Qdrant     : {QDRANT_URL}")
    print(f"  dry-run    : {dry_run}")
    print()

    if not OPENAI_KEY and not dry_run:
        print("ERROR: OPENAI_API_KEY not set"); sys.exit(1)

    if not dry_run:
        ensure_collection()
        _next_id = get_max_point_id()
        print(f"  starting point id: {_next_id}")

    # Load videos
    lines = VIDEOS_FILE.read_text().splitlines()
    videos = []
    for line in lines:
        parts = line.split("|")
        if len(parts) >= 2:
            videos.append({"id": parts[0].strip(), "title": parts[1].strip(),
                           "url": parts[3].strip() if len(parts) > 3 else f"https://www.youtube.com/watch?v={parts[0].strip()}"})

    state = load_state()
    processed_ids = set(state["processed"].keys())

    pending = [v for v in videos if v["id"] not in processed_ids]
    if limit:
        pending = pending[:limit]

    print(f"Total videos : {len(videos)}")
    print(f"Already done : {len(processed_ids)}")
    print(f"To process   : {len(pending)}")
    print()

    t0 = time.time()
    done = skipped = total_chunks = 0

    for i, video in enumerate(pending):
        vid_id = video["id"]
        title  = video["title"]
        url    = video["url"]
        print(f"[{i+1}/{len(pending)}] {title[:70]}", end="", flush=True)

        transcript = fetch_transcript(vid_id)
        if not transcript:
            print(f" — NO TRANSCRIPT")
            skipped += 1
            state["processed"][vid_id] = {"hash": "skip", "chunks": 0, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ")}
            save_state(state)
            continue

        chunks = chunk_text(transcript)
        print(f" — {len(chunks)} chunks", end="", flush=True)

        if dry_run:
            print(f" [dry-run OK]")
            done += 1
            total_chunks += len(chunks)
            continue

        # Batch embed (up to 50 at a time to stay within token limits)
        EMBED_BATCH = 50
        points = []
        try:
            for b_start in range(0, len(chunks), EMBED_BATCH):
                batch = chunks[b_start:b_start + EMBED_BATCH]
                vectors = embed_texts(batch)
                for j, (chunk, vec) in enumerate(zip(batch, vectors)):
                    points.append({
                        "id": _next_id,
                        "vector": vec,
                        "payload": {
                            "collection": COLLECTION,
                            "video_id": vid_id,
                            "title": title,
                            "url": url,
                            "chunk_index": b_start + j,
                            "chunk_total": len(chunks),
                            "content": chunk,
                        }
                    })
                    _next_id += 1
        except Exception as e:
            print(f" — EMBED ERROR: {str(e)[:80]}")
            skipped += 1
            continue

        upsert_points(points)
        total_chunks += len(chunks)
        done += 1

        state["processed"][vid_id] = {
            "hash": hashlib.md5(transcript.encode()).hexdigest()[:16],
            "chunks": len(chunks),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        save_state(state)
        print(f" ✓")

        # Brief pause every 20 videos to avoid rate limits
        if (i + 1) % 20 == 0:
            time.sleep(2)

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  Processed : {done}")
    print(f"  Skipped   : {skipped}")
    print(f"  Chunks    : {total_chunks}")
    if done > 0:
        print(f"  Avg/video : {elapsed/done:.1f}s")

if __name__ == "__main__":
    main()
