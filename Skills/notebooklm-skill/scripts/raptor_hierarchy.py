#!/usr/bin/env python3.12
"""Build a RAPTOR-style hierarchical index over a Qdrant collection.

Reads level-0 chunks, clusters them via k-means on the existing 1536d
embeddings, generates per-cluster summaries with gpt-4o-mini, embeds those
summaries, and upserts as level-1 points. Then synthesizes a level-2
corpus-level summary across all level-1 summaries.

Idempotent: deterministic UUID5 ids per (collection, level, cluster_id).
Re-running upserts in place.

Usage:
    python3.12 raptor_hierarchy.py --collection zouroboros-research [--clusters 20] [--dry-run]
"""
from __future__ import annotations

import argparse
import os
import sys
import uuid

import numpy as np
from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import (
    FieldCondition,
    Filter,
    MatchExcept,
    PointStruct,
)
from sklearn.cluster import KMeans

EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
SUMMARY_MODEL = "gpt-4o-mini"
NS_L1 = uuid.UUID("a1b2c3d4-e5f6-4890-abcd-ef1234567890")
NS_L2 = uuid.UUID("b2c3d4e5-f6a7-4901-bcde-f12345678901")


def fetch_level0(client: QdrantClient, collection: str) -> list:
    """Scroll all points whose payload.level is missing or 0."""
    results = []
    offset = None
    while True:
        points, next_offset = client.scroll(
            collection_name=collection,
            with_vectors=True,
            with_payload=True,
            limit=256,
            offset=offset,
        )
        for p in points:
            level = (p.payload or {}).get("level")
            if level in (None, 0):
                results.append(p)
        if next_offset is None:
            break
        offset = next_offset
    return results


def summarize(openai: OpenAI, prompt: str, dry: bool) -> str:
    if dry:
        return f"[DRY] {prompt[:80]}..."
    r = openai.chat.completions.create(
        model=SUMMARY_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )
    return r.choices[0].message.content.strip()


def embed(openai: OpenAI, text: str, dry: bool) -> list[float]:
    if dry:
        return [0.0] * EMBED_DIM
    return openai.embeddings.create(model=EMBED_MODEL, input=text).data[0].embedding


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--collection", default="zouroboros-research")
    ap.add_argument("--clusters", type=int, default=0,
                    help="k for k-means; default ~sqrt(N)")
    ap.add_argument("--qdrant-url", default=os.environ.get("QDRANT_URL", "http://127.0.0.1:6333"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.dry_run and not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr)
        return 2

    qdrant = QdrantClient(
        url=args.qdrant_url,
        api_key=os.environ.get("QDRANT_API_KEY"),
        check_compatibility=False,
    )
    openai = OpenAI()

    print(f"[raptor] Fetching level-0 points from {args.collection}...")
    pts = fetch_level0(qdrant, args.collection)
    print(f"[raptor] Got {len(pts)} chunks")
    if len(pts) < 4:
        print("[raptor] Too few chunks to cluster — abort.")
        return 1

    vectors = np.array([p.vector for p in pts], dtype=np.float32)
    payloads = [p.payload or {} for p in pts]

    k = args.clusters or max(2, int(np.sqrt(len(pts))))
    print(f"[raptor] k-means with k={k}")
    km = KMeans(n_clusters=k, random_state=42, n_init="auto").fit(vectors)
    labels = km.labels_

    level1_points = []
    for cid in range(k):
        idx = [i for i, l in enumerate(labels) if l == cid]
        if not idx:
            continue
        texts = [payloads[i].get("content") or payloads[i].get("text", "") for i in idx]
        sources = sorted({payloads[i].get("source") or payloads[i].get("file_path", "?") for i in idx})
        joined = "\n\n---\n\n".join(t[:1500] for t in texts[:8])

        prompt = (
            "Summarize the following research-paper chunks. Output 3-5 sentences "
            "capturing the shared theme, key claims, and notable specifics. "
            "Stay technical and concrete.\n\n" + joined
        )
        summary = summarize(openai, prompt, args.dry_run)
        print(f"  cluster {cid:2d} | {len(idx):3d} chunks | {len(sources)} papers | {summary[:100]}...")

        vec = embed(openai, summary, args.dry_run)
        pid = str(uuid.uuid5(NS_L1, f"{args.collection}:l1:{cid}"))
        level1_points.append(PointStruct(
            id=pid,
            vector=vec,
            payload={
                "level": 1,
                "kind": "cluster_summary",
                "cluster_id": cid,
                "size": len(idx),
                "sources": sources,
                "summary": summary,
                "text": summary,
            },
        ))

    if level1_points and not args.dry_run:
        qdrant.upsert(collection_name=args.collection, points=level1_points)
        print(f"[raptor] Upserted {len(level1_points)} level-1 points")

    if level1_points:
        all_summaries = "\n\n".join(f"[{p.payload['cluster_id']}] {p.payload['summary']}" for p in level1_points)
        corpus_prompt = (
            f"You are synthesizing a research corpus. Below are {len(level1_points)} cluster-level "
            "summaries drawn from papers on agent memory, RAG, self-improvement, and multi-agent "
            "systems. Produce a 6-8 sentence corpus-level synthesis. Identify major themes, "
            "complementary techniques, and any contradictions. Stay technical.\n\n" + all_summaries
        )
        corpus_summary = summarize(openai, corpus_prompt, args.dry_run)
        if not args.dry_run:
            cvec = embed(openai, corpus_summary, args.dry_run)
            l2_pid = str(uuid.uuid5(NS_L2, f"{args.collection}:l2:corpus"))
            qdrant.upsert(collection_name=args.collection, points=[PointStruct(
                id=l2_pid,
                vector=cvec,
                payload={
                    "level": 2,
                    "kind": "corpus_summary",
                    "summary": corpus_summary,
                    "text": corpus_summary,
                    "n_clusters": len(level1_points),
                    "n_chunks": len(pts),
                },
            )])
            print(f"[raptor] Upserted level-2 corpus summary")
        print("\n[raptor] CORPUS SUMMARY:\n" + corpus_summary)

    print("\n[raptor] Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
