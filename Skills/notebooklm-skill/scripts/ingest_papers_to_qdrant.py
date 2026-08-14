#!/usr/bin/env python3.12
"""Ingest research-paper PDFs into a Qdrant collection.

Usage:
    python3.12 ingest_papers_to_qdrant.py \
        --pdf-dir /home/workspace/Articles/zouroboros-research-papers \
        --collection zouroboros-research

Idempotent: deterministic point IDs (UUID5 over file_path + chunk_index) mean
re-running is safe and skips already-present chunks via Qdrant upsert semantics.

Embeddings: OpenAI text-embedding-3-small (1536d).
Chunking: 800 tokens, 100 overlap (tiktoken cl100k_base).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import tiktoken
from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
CHUNK_TOKENS = 800
CHUNK_OVERLAP = 100
NS = uuid.UUID("9c5d3b3f-2c2b-4f3a-9f60-1a1b1f2c3d4e")


def pdf_to_text(pdf_path: Path) -> str:
    out = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        raise RuntimeError(f"pdftotext failed for {pdf_path}: {out.stderr}")
    return out.stdout


def chunk_tokens(text: str, tok) -> list[str]:
    tokens = tok.encode(text)
    if len(tokens) <= CHUNK_TOKENS:
        return [text]
    chunks = []
    step = CHUNK_TOKENS - CHUNK_OVERLAP
    for start in range(0, len(tokens), step):
        piece = tokens[start:start + CHUNK_TOKENS]
        chunks.append(tok.decode(piece))
        if start + CHUNK_TOKENS >= len(tokens):
            break
    return chunks


def parse_payload_pairs(pairs: list[str]) -> dict[str, str]:
    extra = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"--payload expects key=value, got: {pair}")
        key, value = pair.split("=", 1)
        extra[key.strip()] = value.strip()
    return extra


def truncate_at(text: str, pattern: str, min_line: int) -> str:
    """Drop everything from the first line past min_line matching pattern.

    Used to exclude back matter (bibliographies, indexes) that would otherwise
    dominate the embedded chunks without carrying retrievable meaning.
    """
    rx = re.compile(pattern)
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if i >= min_line and rx.match(line):
            return "\n".join(lines[:i])
    return text


def build_section_map(text: str, pattern: str, min_line: int) -> list[tuple[int, str]]:
    """Map character offsets to the nearest preceding heading."""
    rx = re.compile(pattern)
    offsets: list[tuple[int, str]] = []
    pos = 0
    for i, line in enumerate(text.split("\n")):
        if i >= min_line and rx.match(line) and ". . ." not in line:
            offsets.append((pos, " ".join(line.split())))
        pos += len(line) + 1
    return offsets


def section_for_offset(section_map: list[tuple[int, str]], offset: int) -> str | None:
    current = None
    for start, title in section_map:
        if start > offset:
            break
        current = title
    return current


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", help="Directory of PDFs to ingest")
    ap.add_argument("--pdf", action="append", default=[],
                    help="Single PDF path (repeatable); may be combined with --pdf-dir")
    ap.add_argument("--collection", required=True)
    ap.add_argument("--qdrant-host", default="127.0.0.1")
    ap.add_argument("--qdrant-port", type=int, default=6333)
    ap.add_argument("--payload", action="append", default=[], metavar="KEY=VALUE",
                    help="Extra payload field on every point (repeatable), e.g. tier=reference")
    ap.add_argument("--collection-role", default="research-paper",
                    help="Value for the collection_role payload field")
    ap.add_argument("--truncate-at-regex",
                    help="Drop text from the first line matching this regex (see --skip-lines)")
    ap.add_argument("--section-regex",
                    help="Lines matching this regex become the 'section' payload for following chunks")
    ap.add_argument("--skip-lines", type=int, default=0,
                    help="Ignore --truncate-at-regex / --section-regex before this line (skips front matter and TOC)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    extra_payload = parse_payload_pairs(args.payload)

    pdfs = [Path(p) for p in args.pdf]
    if args.pdf_dir:
        pdfs += sorted(Path(args.pdf_dir).glob("*.pdf"))
    missing = [p for p in pdfs if not p.is_file()]
    if missing:
        print(f"Missing PDFs: {', '.join(str(p) for p in missing)}", file=sys.stderr)
        sys.exit(1)
    if not pdfs:
        print("No PDFs selected; pass --pdf and/or --pdf-dir", file=sys.stderr)
        sys.exit(1)

    qc = QdrantClient(args.qdrant_host, port=args.qdrant_port)
    existing = {c.name for c in qc.get_collections().collections}
    if args.collection not in existing:
        print(f"Creating collection '{args.collection}' (dim={EMBED_DIM})")
        if not args.dry_run:
            qc.create_collection(
                collection_name=args.collection,
                vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
            )
    else:
        print(f"Collection '{args.collection}' already exists")

    oa = OpenAI()
    tok = tiktoken.get_encoding("cl100k_base")

    total_chunks = 0
    total_tokens = 0
    for pdf in pdfs:
        text = pdf_to_text(pdf)
        if not text.strip():
            print(f"  SKIP {pdf.name}: empty text")
            continue
        if args.truncate_at_regex:
            before = len(tok.encode(text))
            text = truncate_at(text, args.truncate_at_regex, args.skip_lines)
            dropped = before - len(tok.encode(text))
            if dropped:
                print(f"  {pdf.name}: truncated {dropped} tokens of back matter")
        section_map = (build_section_map(text, args.section_regex, args.skip_lines)
                       if args.section_regex else [])
        if args.section_regex:
            print(f"  {pdf.name}: {len(section_map)} sections detected")

        chunks = chunk_tokens(text, tok)
        # Character offset of each chunk start, for section attribution.
        chunk_offsets, cursor = [], 0
        for c in chunks:
            found = text.find(c[:200], cursor) if len(c) >= 200 else text.find(c, cursor)
            cursor = found if found >= 0 else cursor
            chunk_offsets.append(cursor)
        n_tokens = sum(len(tok.encode(c)) for c in chunks)
        total_chunks += len(chunks)
        total_tokens += n_tokens
        print(f"  {pdf.name}: {len(chunks)} chunks, {n_tokens} tokens")

        if args.dry_run:
            continue

        # Deterministic IDs: re-running upserts the same points (idempotent).
        points = []
        # Embed in batches of 64 to respect API limits.
        for batch_start in range(0, len(chunks), 64):
            batch = chunks[batch_start:batch_start + 64]
            resp = oa.embeddings.create(model=EMBED_MODEL, input=batch)
            for i, d in enumerate(resp.data):
                idx = batch_start + i
                point_id = str(uuid.uuid5(NS, f"{pdf.name}::{idx}"))
                payload = {
                    "source": pdf.name,
                    "source_path": str(pdf),
                    "chunk_index": idx,
                    "chunk_count": len(chunks),
                    "content": batch[i],
                    "collection_role": args.collection_role,
                }
                if section_map:
                    payload["section"] = section_for_offset(section_map, chunk_offsets[idx])
                payload.update(extra_payload)
                points.append(PointStruct(id=point_id, vector=d.embedding, payload=payload))
        qc.upsert(collection_name=args.collection, points=points)

    if args.dry_run:
        print(f"\n[DRY-RUN] Would index {total_chunks} chunks, ~{total_tokens} tokens "
              f"(~${total_tokens / 1_000_000 * 0.02:.4f} embed cost).")
    else:
        info = qc.get_collection(args.collection)
        print(f"\nDONE. Collection '{args.collection}' now has {info.points_count} points "
              f"(this run: +{total_chunks} chunks, ~{total_tokens} tokens, "
              f"~${total_tokens / 1_000_000 * 0.02:.4f} embed cost).")


if __name__ == "__main__":
    main()
