#!/usr/bin/env python3
"""Index missing AI Engineer videos as metadata-only Qdrant points."""

import argparse
import json
import os
import re
import time
import urllib.request
import uuid
from pathlib import Path


secrets_path = os.environ.get("ZO_SECRETS_PATH", "/root/.zo_secrets")
if not os.environ.get("OPENAI_API_KEY"):
    try:
        for line in Path(secrets_path).read_text().splitlines():
            match = re.match(r'^export\s+(\w+)=["\']?([^"\']*)["\']?$', line.strip())
            if match:
                os.environ.setdefault(match.group(1), match.group(2))
    except Exception:
        pass


QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333").rstrip("/")
QDRANT_KEY = os.environ.get("QDRANT_API_KEY", "")
COLLECTION = "ai-engineer-videos"
VECTOR_SIZE = 1536
OPENAI_KEY = os.environ.get("OPENAI_API_KEY") or os.environ.get("ZO_OPENAI_API_KEY", "")
VIDEOS_FILE = Path("/home/workspace/Projects/ai-engineer-learning/channel-videos.json")


def q_req(method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if QDRANT_KEY:
        headers["api-key"] = QDRANT_KEY
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{QDRANT_URL}{path}",
        data=data,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def ensure_collection():
    try:
        q_req("GET", f"/collections/{COLLECTION}")
    except Exception:
        q_req("PUT", f"/collections/{COLLECTION}", {
            "vectors": {"size": VECTOR_SIZE, "distance": "Cosine"},
            "on_disk_payload": True,
        })


def existing_video_ids():
    found = set()
    offset = None
    while True:
        body = {
            "limit": 512,
            "with_payload": ["video_id", "source"],
            "with_vector": False,
        }
        if offset is not None:
            body["offset"] = offset
        result = q_req("POST", f"/collections/{COLLECTION}/points/scroll", body)["result"]
        for point in result.get("points", []):
            payload = point.get("payload", {})
            video_id = payload.get("video_id") or payload.get("source")
            if video_id:
                found.add(video_id)
        offset = result.get("next_page_offset")
        if offset is None:
            return found


def metadata_point_id(video_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"ai-engineer-videos:metadata:{video_id}:0"))


def embed_texts(texts):
    payload = json.dumps({"input": texts, "model": "text-embedding-3-small"}).encode()
    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_KEY}",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read())
    return [item["embedding"] for item in data["data"]]


def upsert_points(points):
    q_req("PUT", f"/collections/{COLLECTION}/points?wait=true", {"points": points})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if not VIDEOS_FILE.exists():
        raise SystemExit(f"Catalog is missing: {VIDEOS_FILE}")
    if not OPENAI_KEY and not args.dry_run:
        raise SystemExit("OPENAI_API_KEY is unavailable")

    videos = json.loads(VIDEOS_FILE.read_text())
    ensure_collection()
    existing = existing_video_ids()
    missing = [video for video in videos if video["id"] not in existing]
    if args.limit > 0:
        missing = missing[:args.limit]

    print("AI Engineer Learning - Metadata Index")
    print(f"Catalog videos: {len(videos)}")
    print(f"Existing unique videos: {len(existing)}")
    print(f"Missing videos: {len(missing)}")

    if args.dry_run or not missing:
        return

    started = time.time()
    indexed = 0
    batch_size = 50
    for start in range(0, len(missing), batch_size):
        batch = missing[start:start + batch_size]
        texts = [
            f"Title: {video['title']}\nDuration: {video.get('duration', '0')}\nURL: {video['url']}"
            for video in batch
        ]
        vectors = embed_texts(texts)
        if len(vectors) != len(batch):
            raise RuntimeError(f"Embedding count mismatch: {len(vectors)} != {len(batch)}")
        points = []
        for video, text, vector in zip(batch, texts, vectors):
            points.append({
                "id": metadata_point_id(video["id"]),
                "vector": vector,
                "payload": {
                    "collection": COLLECTION,
                    "video_id": video["id"],
                    "title": video["title"],
                    "url": video["url"],
                    "duration": video.get("duration", "0"),
                    "chunk_index": 0,
                    "chunk_total": 1,
                    "content": text,
                    "has_transcript": False,
                },
            })
        upsert_points(points)
        indexed += len(points)
        print(f"Indexed {indexed}/{len(missing)}")

    print(f"Completed: {indexed} metadata points in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
