"""Smoke tests for Adoption 1 (citations) + Adoption 4 (topics).

Tests the persistence helpers without requiring live NotebookLM.
Run: python3.12 -m pytest tests/ (or just python3.12 tests/test_adoption_1_4.py)
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))

from extract_topics import slugify, persist_topics, list_topics, get_topic_facts
from resolve_citations import chunk_md5, persist_ask_result
from notebooklm.types import AskResult, ChatReference  # type: ignore


def _fresh_db() -> Path:
    """Create empty mimir.db with required schema."""
    fd = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    db_path = Path(fd.name)
    fd.close()
    schema = Path("/home/workspace/Skills/zo-memory-system/scripts/schema.sql").read_text()
    conn = sqlite3.connect(str(db_path))
    conn.executescript(schema)
    conn.close()
    return db_path


def test_chunk_md5_stable():
    """Same text → same hash; different text → different. Recipe: md5(cited_text[:100])."""
    h1 = chunk_md5("hello world")
    h2 = chunk_md5("hello world")
    h3 = chunk_md5("hello other")
    assert h1 == h2, "stable hash"
    assert h1 != h3, "different content → different hash"
    # Verify the [:100] truncation: same first-100 chars → same hash
    long_a = "x" * 50 + "ABCDEFGHIJ" * 5 + "_diff_a"
    long_b = "x" * 50 + "ABCDEFGHIJ" * 5 + "_diff_b"
    assert chunk_md5(long_a) == chunk_md5(long_b), "first-100 chars match → same hash"


def test_slugify():
    assert slugify("Claude Code") == "claude-code"
    assert slugify("Obsidian Bases!") == "obsidian-bases"
    assert slugify("...") == "untitled"
    assert slugify("a" * 100, max_len=10) == "aaaaaaaaaa"


def test_persist_ask_result():
    db = _fresh_db()
    refs = [
        ChatReference(source_id="src-1", citation_number=1,
                      cited_text="Test quote one.", start_char=0, end_char=15, chunk_id="c1"),
        ChatReference(source_id="src-1", citation_number=2,
                      cited_text="Test quote two.", start_char=20, end_char=35, chunk_id="c2"),
    ]
    result = AskResult(
        answer="Synthesized answer.",
        conversation_id="test-conv-1",
        turn_number=1,
        is_follow_up=False,
        references=refs,
        raw_response="",
    )
    summary = persist_ask_result(
        result, notebook_id="nb-1", agent_slug="test-agent",
        question="What?", source_titles={"src-1": "Source One"},
        db_path=db,
    )
    assert summary["chunks_written"] == 2
    assert summary["total_refs"] == 2

    conn = sqlite3.connect(str(db))
    cnt = conn.execute("SELECT COUNT(*) FROM source_chunks").fetchone()[0]
    assert cnt == 2
    cnt = conn.execute("SELECT COUNT(*) FROM fact_citations").fetchone()[0]
    assert cnt == 2
    conn.close()


def test_persist_topics_idempotent():
    db = _fresh_db()
    fid = "qa:test-conv:1"
    topics = [
        {"id": "claude-code", "display_name": "Claude Code", "description": "test"},
        {"id": "rag", "display_name": "RAG", "description": None},
    ]
    s1 = persist_topics(fid, topics, db_path=db)
    s2 = persist_topics(fid, topics, db_path=db)
    assert s1["topics_written"] == 2, f"first call should write 2, got {s1}"
    assert s2["topics_written"] == 0, f"second call should write 0, got {s2}"
    assert s1["topics_linked"] == 2, f"first call should link 2, got {s1}"
    assert s2["topics_linked"] == 0, f"second call should link 0 (already linked), got {s2}"
    assert s2["topic_ids"] == ["claude-code", "rag"], f"topic_ids should still be reported, got {s2}"


def test_list_and_get_topic():
    db = _fresh_db()
    fid = "qa:test:1"
    persist_topics(fid, [{"id": "t1", "display_name": "Topic One", "description": None}], db_path=db)
    # Need a fact_citation row for get_topic_facts to find Q/A excerpts; insert one.
    conn = sqlite3.connect(str(db))
    conn.execute(
        "INSERT INTO source_chunks (chunk_md5, source_id, source_title, cited_text, "
        "start_char, end_char, chunk_id, notebook_id, agent_slug, first_seen_at, last_seen_at, hit_count) "
        "VALUES ('m1','s1','t','x',0,1,'c1','nb1','a',1,1,1)"
    )
    conn.execute(
        "INSERT INTO fact_citations (fact_id, chunk_md5, citation_number, source_kind, "
        "conversation_id, turn_number, question, answer_excerpt, created_at) "
        "VALUES (?,'m1',1,'qa','test',1,'Q?','A.',1)", (fid,)
    )
    conn.commit()
    conn.close()

    topics = list_topics(db_path=db)
    assert len(topics) == 1
    assert topics[0]["id"] == "t1"

    result = get_topic_facts("t1", db_path=db)
    assert result["topic"]["id"] == "t1", f"topic mismatch: {result['topic']}"
    assert len(result["facts"]) == 1, f"expected 1 fact, got {result['facts']}"
    assert result["facts"][0]["question"] == "Q?", f"Q mismatch: {result['facts'][0]}"


def test_extract_topics_with_live_openai():
    """Requires OPENAI_API_KEY. Tests the real LLM extraction."""
    import os
    if not os.environ.get("OPENAI_API_KEY"):
        print("  SKIP test_extract_topics_with_live_openai (no API key)")
        return
    from extract_topics import extract_topics
    topics = extract_topics(
        "What is Claude Code?",
        "Claude Code is Anthropic's terminal-based coding agent. It supports skills, MCP servers, and persistent memory."
    )
    assert len(topics) >= 1, f"expected ≥1 topic, got {topics}"
    assert any("claude" in t["id"].lower() for t in topics), f"expected claude topic, got {[t['id'] for t in topics]}"


if __name__ == "__main__":
    tests = [
        test_chunk_md5_stable,
        test_slugify,
        test_persist_ask_result,
        test_persist_topics_idempotent,
        test_list_and_get_topic,
        test_extract_topics_with_live_openai,
    ]
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {fn.__name__}: {e}")
            sys.exit(1)
        except Exception as e:
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
            sys.exit(1)
    print("\nAll tests passed.")
