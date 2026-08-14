"""Persist NotebookLM AskResult citations to shared memory.

Each ChatReference carries a verbatim `cited_text` slice from a NotebookLM source.
We hash it (md5 of cited_text[:100], raw — no normalization, per Artem's recipe)
and store it in `source_chunks`. Each Q&A turn becomes a synthetic fact_id of the
form `qa:{conversation_id}:{turn_number}` linked to all chunks via `fact_citations`.

That gives shared memory a permanent provenance trail: any answer can be traced back to
the exact source slices that backed it, even if the upstream notebook is later
deleted or reshuffled.
"""
from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path
from typing import Any

DEFAULT_DB = Path("/home/workspace/.zo/memory/shared-facts.db")


def chunk_md5(cited_text: str) -> str:
    """Artem's recipe: md5(cited_text[:100].encode()), full 32-char hex, raw."""
    return hashlib.md5(cited_text[:100].encode("utf-8")).hexdigest()


def _source_titles(client_or_titles, notebook_id: str) -> dict[str, str]:
    """Return {source_id: title} either from a passed dict or by querying client."""
    if isinstance(client_or_titles, dict):
        return client_or_titles
    try:
        sources = client_or_titles.sources.list(notebook_id)
        # list() may be sync or async depending on lib version; we only call from
        # sync context where caller has already resolved it
        return {s.id: getattr(s, "title", "") or "" for s in sources}
    except Exception:
        return {}


def persist_ask_result(
    result: Any,
    notebook_id: str,
    agent_slug: str | None = None,
    question: str | None = None,
    source_titles: dict[str, str] | None = None,
    db_path: Path | str = DEFAULT_DB,
) -> dict:
    """Write AskResult.references to shared-facts.db.

    Returns a summary dict: {fact_id, chunks_written, chunks_seen, chunk_md5s}.
    Safe to call repeatedly — UPSERTs hit_count/last_seen_at on duplicate chunks.
    """
    refs = getattr(result, "references", None) or []
    conv_id = getattr(result, "conversation_id", None)
    turn = getattr(result, "turn_number", None)
    answer = getattr(result, "answer", "") or ""
    fact_id = f"qa:{conv_id}:{turn}" if conv_id and turn is not None else f"qa:adhoc:{int(time.time())}"
    now = int(time.time())
    titles = source_titles or {}

    db = sqlite3.connect(str(db_path))
    db.execute("PRAGMA foreign_keys = ON")
    written = 0
    seen = 0
    md5s: list[str] = []
    try:
        for idx, ref in enumerate(refs, start=1):
            cited = getattr(ref, "cited_text", None)
            if not cited or not cited.strip():
                continue
            md5 = chunk_md5(cited)
            md5s.append(md5)
            source_id = getattr(ref, "source_id", "") or ""
            title = titles.get(source_id, "")
            row = db.execute("SELECT hit_count FROM source_chunks WHERE chunk_md5 = ?", (md5,)).fetchone()
            if row:
                db.execute(
                    "UPDATE source_chunks SET hit_count = hit_count + 1, last_seen_at = ? WHERE chunk_md5 = ?",
                    (now, md5),
                )
                seen += 1
            else:
                db.execute(
                    """INSERT INTO source_chunks
                       (chunk_md5, source_id, source_title, cited_text, start_char, end_char,
                        chunk_id, notebook_id, agent_slug, first_seen_at, last_seen_at, hit_count)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                    (
                        md5, source_id, title, cited,
                        getattr(ref, "start_char", None),
                        getattr(ref, "end_char", None),
                        getattr(ref, "chunk_id", None),
                        notebook_id, agent_slug, now, now,
                    ),
                )
                written += 1

            db.execute(
                """INSERT OR IGNORE INTO fact_citations
                   (fact_id, chunk_md5, citation_number, source_kind,
                    conversation_id, turn_number, question, answer_excerpt, created_at)
                   VALUES (?, ?, ?, 'qa', ?, ?, ?, ?, ?)""",
                (
                    fact_id, md5,
                    getattr(ref, "citation_number", None) or idx,
                    conv_id, turn, question, answer[:200], now,
                ),
            )
        db.commit()
    finally:
        db.close()

    return {
        "fact_id": fact_id,
        "chunks_written": written,
        "chunks_seen": seen,
        "total_refs": len(refs),
        "chunk_md5s": md5s,
    }
