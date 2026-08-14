"""Qdrant + gpt-4o-mini backend for agent_research.py.

Per-agent collection pattern: one Qdrant collection per agent slug,
named `agent-<slug>`. Chunks are token-bounded (default 800, overlap 100).
Answers are grounded in top-k retrieved chunks with bracket citations.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Any

import tiktoken
from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams


EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536
CHAT_MODEL = "gpt-4o-mini"
CHUNK_TOKENS = 800
CHUNK_OVERLAP = 100
TOP_K = 8


def collection_name(slug: str) -> str:
    return f"agent-{slug}"


@dataclass
class AskResult:
    answer: str
    citations: list[dict[str, Any]]

    def __str__(self) -> str:
        cite_lines = "\n".join(
            f"  [{i+1}] {c['title']} (score={c['score']:.3f})"
            for i, c in enumerate(self.citations)
        )
        return f"{self.answer}\n\nSources:\n{cite_lines}"


class QdrantBackend:
    def __init__(
        self,
        qdrant_host: str = "127.0.0.1",
        qdrant_port: int = 6333,
        openai_api_key: str | None = None,
    ):
        self.qc = QdrantClient(qdrant_host, port=qdrant_port)
        self.oa = OpenAI(api_key=openai_api_key or os.environ["OPENAI_API_KEY"])
        self.tok = tiktoken.encoding_for_model("gpt-4o-mini")

    def _ensure_collection(self, slug: str) -> str:
        name = collection_name(slug)
        existing = {c.name for c in self.qc.get_collections().collections}
        if name not in existing:
            self.qc.create_collection(
                collection_name=name,
                vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
            )
        return name

    def _chunk(self, text: str) -> list[str]:
        tokens = self.tok.encode(text)
        if len(tokens) <= CHUNK_TOKENS:
            return [text]
        out = []
        step = CHUNK_TOKENS - CHUNK_OVERLAP
        for start in range(0, len(tokens), step):
            piece = tokens[start : start + CHUNK_TOKENS]
            out.append(self.tok.decode(piece))
            if start + CHUNK_TOKENS >= len(tokens):
                break
        return out

    def _embed(self, texts: list[str]) -> list[list[float]]:
        resp = self.oa.embeddings.create(model=EMBED_MODEL, input=texts)
        return [d.embedding for d in resp.data]

    def add_text(
        self,
        slug: str,
        title: str,
        content: str,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        name = self._ensure_collection(slug)
        chunks = self._chunk(content)
        vectors = self._embed(chunks)
        source_id = str(uuid.uuid4())
        points = [
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vec,
                payload={
                    "source_id": source_id,
                    "title": title,
                    "chunk_index": i,
                    "chunk_count": len(chunks),
                    "content": chunk_text,
                    "tags": tags or [],
                    "slug": slug,
                },
            )
            for i, (chunk_text, vec) in enumerate(zip(chunks, vectors))
        ]
        self.qc.upsert(collection_name=name, points=points)
        return {
            "source_id": source_id,
            "collection": name,
            "chunks_added": len(chunks),
            "tokens": sum(len(self.tok.encode(c)) for c in chunks),
        }

    def ask(self, slug: str, question: str, top_k: int = TOP_K) -> AskResult:
        name = collection_name(slug)
        qvec = self._embed([question])[0]
        hits = self.qc.query_points(
            collection_name=name, query=qvec, limit=top_k
        ).points
        if not hits:
            return AskResult(
                answer="(no sources in this notebook yet)",
                citations=[],
            )
        context_blocks = []
        citations = []
        for i, h in enumerate(hits):
            label = f"[{i+1}]"
            context_blocks.append(f"{label} {h.payload['title']}\n{h.payload['content']}")
            citations.append(
                {
                    "title": h.payload["title"],
                    "score": float(h.score),
                    "source_id": h.payload.get("source_id"),
                }
            )
        prompt = (
            "Answer the question using only the numbered context below. "
            "Cite sources as [1], [2], etc. If the context doesn't contain the answer, say so.\n\n"
            f"{chr(10).join(context_blocks)}\n\n"
            f"Question: {question}"
        )
        resp = self.oa.chat.completions.create(
            model=CHAT_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
        )
        return AskResult(
            answer=resp.choices[0].message.content,
            citations=citations,
        )

    def collection_stats(self, slug: str) -> dict[str, Any]:
        name = collection_name(slug)
        try:
            info = self.qc.get_collection(name)
            return {
                "collection": name,
                "points": info.points_count,
                "vectors": info.vectors_count,
            }
        except Exception:
            return {"collection": name, "points": 0, "vectors": 0}
