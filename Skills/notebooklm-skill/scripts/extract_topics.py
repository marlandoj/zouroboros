"""Topic extraction + persistence for agent_research Q&A turns (Adoption 4).

Each Q&A turn is processed by gpt-4o-mini to extract 3-7 topical hubs.
Topics are slug-keyed (lowercase, hyphenated) and UPSERTed to shared-facts.db's
`topics` table; the synthetic fact_id is linked to each topic via
`fact_topics`. This makes "every fact about <topic>" a 1-query lookup
instead of a substring scan.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

DEFAULT_DB = Path("/home/workspace/.zo/memory/shared-facts.db")
TOPIC_MODEL = "gpt-4o-mini"
MAX_TOPICS = 7
MIN_TOPICS = 3

EXTRACTION_PROMPT = """Extract the 3-7 most central topics from this Q&A turn.

Return a json object: {{"topics": [{{"display_name": "Claude Code", "description": "Anthropic's terminal coding agent"}}, ...]}}

Rules:
- Topics are concept hubs that other Q&As about the same domain should also use (e.g. "Claude Code", "Obsidian Bases", "RAG").
- Prefer specific named entities over generic categories ("Obsidian Bases" over "note-taking").
- Description: one short sentence (≤80 chars), or null.
- 3-7 topics. No more, no less unless the answer is genuinely shallow.

Question: {question}

Answer: {answer}"""

_SLUG_RX = re.compile(r"[^a-z0-9]+")


def slugify(name: str, max_len: int = 50) -> str:
    s = _SLUG_RX.sub("-", name.lower()).strip("-")
    return s[:max_len].rstrip("-") or "untitled"


def extract_topics(
    question: str,
    answer: str,
    *,
    model: str = TOPIC_MODEL,
    api_key: str | None = None,
) -> list[dict[str, str]]:
    """Call gpt-4o-mini to extract topics. Returns [] on any error (non-fatal)."""
    if not answer or not answer.strip():
        return []
    try:
        from openai import OpenAI
    except ImportError:
        return []

    key = api_key or os.environ.get("OPENAI_API_KEY")
    if not key:
        return []

    try:
        client = OpenAI(api_key=key)
        resp = client.chat.completions.create(
            model=model,
            messages=[{
                "role": "user",
                "content": EXTRACTION_PROMPT.format(
                    question=question[:500],
                    answer=answer[:4000],
                ),
            }],
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        topics = parsed.get("topics", []) or []
    except Exception:
        return []

    out: list[dict[str, str]] = []
    seen_slugs: set[str] = set()
    for t in topics[:MAX_TOPICS]:
        if not isinstance(t, dict):
            continue
        name = (t.get("display_name") or "").strip()
        if not name:
            continue
        sid = slugify(name)
        if sid in seen_slugs:
            continue
        seen_slugs.add(sid)
        desc = (t.get("description") or "").strip() or None
        out.append({"id": sid, "display_name": name, "description": desc})
    return out


def persist_topics(
    fact_id: str,
    topics: list[dict[str, Any]],
    *,
    db_path: Path | str = DEFAULT_DB,
) -> dict[str, Any]:
    """UPSERT topics and link them to fact_id. Idempotent."""
    if not topics:
        return {"topics_written": 0, "topics_linked": 0, "topic_ids": []}

    now = int(time.time())
    db = sqlite3.connect(str(db_path))
    db.execute("PRAGMA foreign_keys = ON")
    written = 0
    linked = 0
    ids: list[str] = []
    try:
        for t in topics:
            tid = t["id"]
            ids.append(tid)
            existing = db.execute(
                "SELECT 1 FROM topics WHERE id = ?", (tid,)
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE topics SET last_seen_at = ?, fact_count = fact_count + 1 WHERE id = ?",
                    (now, tid),
                )
            else:
                db.execute(
                    """INSERT INTO topics
                       (id, display_name, description, fact_count, first_seen_at, last_seen_at)
                       VALUES (?, ?, ?, 1, ?, ?)""",
                    (tid, t["display_name"], t.get("description"), now, now),
                )
                written += 1

            cur = db.execute(
                """INSERT OR IGNORE INTO fact_topics (fact_id, topic_id, weight, created_at)
                   VALUES (?, ?, 1.0, ?)""",
                (fact_id, tid, now),
            )
            if cur.rowcount > 0:
                linked += 1
        db.commit()
    finally:
        db.close()

    return {"topics_written": written, "topics_linked": linked, "topic_ids": ids}


def list_topics(*, limit: int = 50, db_path: Path | str = DEFAULT_DB) -> list[dict[str, Any]]:
    db = sqlite3.connect(str(db_path))
    try:
        rows = db.execute(
            """SELECT id, display_name, description, fact_count, last_seen_at
               FROM topics ORDER BY last_seen_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    finally:
        db.close()
    return [
        {"id": r[0], "display_name": r[1], "description": r[2],
         "fact_count": r[3], "last_seen_at": r[4]}
        for r in rows
    ]


def get_topic_facts(topic_id: str, *, limit: int = 50, db_path: Path | str = DEFAULT_DB) -> dict[str, Any]:
    db = sqlite3.connect(str(db_path))
    try:
        topic = db.execute(
            "SELECT id, display_name, description, fact_count FROM topics WHERE id = ?",
            (topic_id,),
        ).fetchone()
        if not topic:
            return {"topic": None, "facts": []}
        rows = db.execute(
            """SELECT ft.fact_id, ft.created_at,
                      (SELECT question FROM fact_citations
                       WHERE fact_id = ft.fact_id LIMIT 1) AS question,
                      (SELECT answer_excerpt FROM fact_citations
                       WHERE fact_id = ft.fact_id LIMIT 1) AS answer_excerpt
               FROM fact_topics ft
               WHERE ft.topic_id = ?
               ORDER BY ft.created_at DESC LIMIT ?""",
            (topic_id, limit),
        ).fetchall()
    finally:
        db.close()
    return {
        "topic": {
            "id": topic[0], "display_name": topic[1],
            "description": topic[2], "fact_count": topic[3],
        },
        "facts": [
            {"fact_id": r[0], "created_at": r[1], "question": r[2], "answer_excerpt": r[3]}
            for r in rows
        ],
    }
