---
title: NotebookLM Query Response Shape
date: 2026-04-26
type: schema-reference
source: notebooklm-py 0.3.4 (/usr/local/lib/python3.12/site-packages/notebooklm/types.py)
verification: library-types (runtime verification deferred — auth expired since 2026-04-25)
---

# Query Response Schema — `nlm.py ask` / `client.chat.ask()`

**Plan amendment:** Original plan referenced `nlm notebook query --json` (Artem's Go CLI). Our local stack uses Python `notebooklm-py` v0.3.4 with command `nlm.py ask --notebook <id> --question <q>`. Underlying API: `client.chat.ask(notebook_id, question) -> AskResult`.

## `AskResult` (top-level return)

```python
@dataclass
class AskResult:
    answer: str                              # AI-generated answer text with [N] markers
    conversation_id: str                     # UUID for follow-ups
    turn_number: int
    is_follow_up: bool
    references: list[ChatReference]          # source citations
    raw_response: str                        # first 1000 chars for debugging
```

## `ChatReference` (the citation atom — **what Adoption 1 hashes**)

```python
@dataclass
class ChatReference:
    source_id: str                           # source UUID this reference points to
    citation_number: int | None = None       # the [N] marker shown in the answer
    cited_text: str | None = None            # ★ verbatim passage — Adoption 1 MD5 input
    start_char: int | None = None            # offset in source content
    end_char: int | None = None
    chunk_id: str | None = None              # internal chunk ID (debugging)
```

## Adoption 1 contract (locked against this schema)

- **Input to MD5:** `cited_text[:100]` lowercased + whitespace-normalized (matches Artem's recipe).
- **Idempotency:** same `cited_text` prefix → same `chunk_md5` across runs. ✓ deterministic.
- **`citation_number` → `marker_index`:** maps to `fact_citations.marker_index` column.
- **`source_id` → resolve to source title via** `client.sources.list(notebook_id)` (separate call; Artem caches per-notebook).
- **Graceful degradation:** `cited_text` is `Optional[str]`. Resolver MUST skip references where `cited_text is None` (library returns empty references list on parse failure — see `_chat.py:627`).

## Runtime verification status

- ✅ **Schema:** confirmed via authoritative dataclass definitions in library source.
- ⚠️ **Live query:** blocked — auth expired 2026-04-25. Keepalive failing in `~/.notebooklm/keepalive.log` (single success on 2026-04-24, all subsequent runs redirect to Google sign-in).
- 📌 **Resolution:** Adoption 1 implementation can proceed against the typed schema. Live citation flow validates on next auth refresh (manual cookie re-export per `notebooklm-skill/SKILL.md` Method B).

## Where the parse logic lives (for future maintainers)

- `_chat.py:436` — `_parse_ask_response_with_references()` — top-level parser
- `_chat.py:514` — chunk-level parser
- `_chat.py:687-735` — `_extract_text_passages()` — actual `cited_text` extraction (joins multi-passage citations with `" "` delimiter)

If NotebookLM changes the wire format, `_chat.py` is where the library will need patching, not our code. Our resolver consumes typed `ChatReference` objects.
