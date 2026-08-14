#!/usr/bin/env python3.12
"""Per-agent research notebooks for Zo scheduled agents.

Turns ephemeral agent output into a durable, queryable knowledge base.
Each agent slug maps to its own notebook (Qdrant collection by default,
NotebookLM notebook as fallback). Repeated runs append new sources.

Usage:
    agent_research.py append <agent-slug> [--file PATH | --stdin] [--title TITLE] [--tag TAG]...
    agent_research.py ask <agent-slug> --question "what did we learn last week about X?"
    agent_research.py list
    agent_research.py url <agent-slug>
    agent_research.py register <agent-slug> --notebook <id>     # bind existing notebook (notebooklm backend only)
    agent_research.py unregister <agent-slug>                    # drop from registry

Backend selection:
    --backend qdrant      (default) Qdrant + gpt-4o-mini, local, no session auth
    --backend notebooklm  NotebookLM consumer UI via cookie auth (fragile under DBSC)

Registry: ~/.notebooklm/agent_notebooks.json
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


REGISTRY = Path.home() / ".notebooklm" / "agent_notebooks.json"
NOTEBOOK_URL_TMPL = "https://notebooklm.google.com/notebook/{nb_id}"
DEFAULT_BACKEND = "qdrant"


def load_registry() -> dict:
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text())
    return {}


def save_registry(reg: dict) -> None:
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps(reg, indent=2, sort_keys=True))


def slug_to_title(slug: str) -> str:
    return "Agent Research — " + slug.replace("-", " ").replace("_", " ").title()


def resolve_backend(agent_slug: str, explicit: str | None, reg: dict) -> str:
    """Backend selection: explicit flag > registry entry > default."""
    if explicit:
        return explicit
    if agent_slug in reg and reg[agent_slug].get("backend"):
        return reg[agent_slug]["backend"]
    return DEFAULT_BACKEND


# ---------------------------------------------------------------------------
# Qdrant backend
# ---------------------------------------------------------------------------

def _qdrant_backend():
    from qdrant_backend import QdrantBackend
    return QdrantBackend()


def qdrant_append(args) -> None:
    content, default_title = _read_input(args)
    header = _build_header(args)
    body = header + content
    title = args.title or default_title

    reg = load_registry()
    b = _qdrant_backend()
    result = b.add_text(args.agent, title=title, content=body, tags=args.tag)

    entry = reg.get(args.agent, {})
    entry.update({
        "backend": "qdrant",
        "collection": result["collection"],
        "title": entry.get("title") or slug_to_title(args.agent),
        "created_at": entry.get("created_at") or datetime.now(timezone.utc).isoformat(),
        "source_count": entry.get("source_count", 0) + 1,
        "last_append_at": datetime.now(timezone.utc).isoformat(),
    })
    reg[args.agent] = entry
    save_registry(reg)
    print(json.dumps({
        "agent": args.agent,
        "backend": "qdrant",
        "collection": result["collection"],
        "source_id": result["source_id"],
        "source_title": title,
        "chunks_added": result["chunks_added"],
        "tokens": result["tokens"],
        "source_count": entry["source_count"],
    }, indent=2))


def qdrant_ask(args) -> None:
    b = _qdrant_backend()
    result = b.ask(args.agent, args.question)
    answer = getattr(result, "answer", str(result))

    topic_summary = None
    fact_id = f"qa:qdrant:{args.agent}:{int(__import__('time').time())}"
    if not getattr(args, "no_topics", False):
        try:
            sys.path.insert(0, str(Path(__file__).parent))
            from extract_topics import extract_topics, persist_topics
            topics = extract_topics(args.question, answer)
            if topics:
                topic_summary = persist_topics(fact_id, topics)
        except Exception as e:
            print(f"WARN: topic extraction failed: {e}", file=sys.stderr)

    if topic_summary:
        print(json.dumps({
            "agent": args.agent,
            "backend": "qdrant",
            "answer": answer,
            "citations": getattr(result, "citations", []),
            "fact_id": fact_id,
            "topics": topic_summary,
        }, indent=2))
    else:
        print(result)


# ---------------------------------------------------------------------------
# NotebookLM backend (legacy fallback)
# ---------------------------------------------------------------------------

async def _nlm_client():
    from notebooklm import NotebookLMClient
    storage = Path.home() / ".notebooklm" / "storage_state.json"
    if not storage.exists():
        print("ERROR: Not authenticated. See notebooklm-skill SKILL.md.", file=sys.stderr)
        sys.exit(1)
    client = await NotebookLMClient.from_storage()
    await client.__aenter__()
    return client


async def _nlm_ensure_notebook(client, slug: str, reg: dict) -> str:
    if slug in reg and reg[slug].get("notebook_id"):
        return reg[slug]["notebook_id"]
    title = slug_to_title(slug)
    nb = await client.notebooks.create(title=title)
    nb_id = getattr(nb, "id", str(nb))
    reg[slug] = {
        "backend": "notebooklm",
        "notebook_id": nb_id,
        "title": title,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_count": 0,
    }
    save_registry(reg)
    print(f"Created notebook for '{slug}': {nb_id}", file=sys.stderr)
    return nb_id


async def nlm_append(args) -> None:
    content, default_title = _read_input(args)
    header = _build_header(args)
    body = header + content
    title = args.title or default_title

    reg = load_registry()
    client = await _nlm_client()
    try:
        nb_id = await _nlm_ensure_notebook(client, args.agent, reg)
        await client.sources.add_text(nb_id, title=title, content=body)
        reg[args.agent]["source_count"] = reg[args.agent].get("source_count", 0) + 1
        reg[args.agent]["last_append_at"] = datetime.now(timezone.utc).isoformat()
        save_registry(reg)
        print(json.dumps({
            "agent": args.agent,
            "backend": "notebooklm",
            "notebook_id": nb_id,
            "notebook_url": NOTEBOOK_URL_TMPL.format(nb_id=nb_id),
            "source_title": title,
            "source_count": reg[args.agent]["source_count"],
            "bytes_appended": len(body.encode("utf-8")),
        }, indent=2))
    finally:
        await client.__aexit__(None, None, None)


async def nlm_ask(args) -> None:
    reg = load_registry()
    if args.agent not in reg or not reg[args.agent].get("notebook_id"):
        print(f"ERROR: no NotebookLM notebook registered for '{args.agent}'", file=sys.stderr)
        sys.exit(2)
    nb_id = reg[args.agent]["notebook_id"]
    client = await _nlm_client()
    try:
        result = await client.chat.ask(nb_id, args.question)
        answer = getattr(result, "answer", str(result))
        conv_id = getattr(result, "conversation_id", None)
        turn = getattr(result, "turn_number", None)
        fact_id = (
            f"qa:{conv_id}:{turn}"
            if conv_id and turn is not None
            else f"qa:adhoc:{int(__import__('time').time())}"
        )

        citation_summary = None
        if not getattr(args, "no_citations", False):
            try:
                sys.path.insert(0, str(Path(__file__).parent))
                from resolve_citations import persist_ask_result
                titles = {}
                try:
                    sources = await client.sources.list(nb_id)
                    titles = {s.id: getattr(s, "title", "") or "" for s in sources}
                except Exception:
                    pass
                citation_summary = persist_ask_result(
                    result, notebook_id=nb_id, agent_slug=args.agent,
                    question=args.question, source_titles=titles,
                )
            except Exception as e:
                print(f"WARN: citation persistence failed: {e}", file=sys.stderr)

        topic_summary = None
        if not getattr(args, "no_topics", False):
            try:
                sys.path.insert(0, str(Path(__file__).parent))
                from extract_topics import extract_topics, persist_topics
                topics = extract_topics(args.question, answer)
                if topics:
                    topic_summary = persist_topics(fact_id, topics)
            except Exception as e:
                print(f"WARN: topic extraction failed: {e}", file=sys.stderr)

        print(json.dumps({
            "agent": args.agent,
            "answer": answer,
            "conversation_id": conv_id,
            "turn_number": turn,
            "fact_id": fact_id,
            "citations": citation_summary,
            "topics": topic_summary,
        }, indent=2))
    finally:
        await client.__aexit__(None, None, None)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _read_input(args) -> tuple[str, str]:
    if not args.file and not args.stdin:
        print("ERROR: provide --file PATH or --stdin", file=sys.stderr)
        sys.exit(2)
    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"ERROR: file not found: {path}", file=sys.stderr)
            sys.exit(2)
        return path.read_text(), path.name
    content = sys.stdin.read()
    default_title = f"{args.agent}-run-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.md"
    if not content.strip():
        print("ERROR: empty content, nothing to append", file=sys.stderr)
        sys.exit(2)
    return content, default_title


def _build_header(args) -> str:
    lines = [f"# {args.agent} — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"]
    if args.tag:
        lines.append("Tags: " + ", ".join(args.tag))
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Dispatchers
# ---------------------------------------------------------------------------

def cmd_append(args) -> None:
    reg = load_registry()
    backend = resolve_backend(args.agent, args.backend, reg)
    if backend == "qdrant":
        qdrant_append(args)
    elif backend == "notebooklm":
        asyncio.run(nlm_append(args))
    else:
        print(f"ERROR: unknown backend '{backend}'", file=sys.stderr)
        sys.exit(2)


def cmd_ask(args) -> None:
    reg = load_registry()
    backend = resolve_backend(args.agent, args.backend, reg)
    if backend == "qdrant":
        qdrant_ask(args)
    elif backend == "notebooklm":
        asyncio.run(nlm_ask(args))
    else:
        print(f"ERROR: unknown backend '{backend}'", file=sys.stderr)
        sys.exit(2)


def cmd_list(args) -> None:
    reg = load_registry()
    if not reg:
        print("No agent notebooks registered yet.")
        return
    print(f"{'Agent':<35} {'Backend':<12} {'Sources':<8} {'Last Append':<22} {'Location'}")
    print("-" * 130)
    for slug, info in sorted(reg.items()):
        last = (info.get("last_append_at") or info.get("created_at") or "")[:19]
        backend = info.get("backend") or ("notebooklm" if info.get("notebook_id") else "?")
        if backend == "qdrant":
            loc = info.get("collection") or f"agent-{slug}"
        else:
            nb_id = info.get("notebook_id", "")
            loc = NOTEBOOK_URL_TMPL.format(nb_id=nb_id) if nb_id else ""
        print(f"{slug:<35} {backend:<12} {str(info.get('source_count', 0)):<8} {last:<22} {loc}")


def cmd_url(args) -> None:
    reg = load_registry()
    if args.agent not in reg:
        print(f"ERROR: no notebook registered for '{args.agent}'", file=sys.stderr)
        sys.exit(2)
    info = reg[args.agent]
    backend = info.get("backend") or ("notebooklm" if info.get("notebook_id") else "qdrant")
    if backend == "qdrant":
        print(info.get("collection") or f"agent-{args.agent}")
    else:
        nb_id = info.get("notebook_id", "")
        if not nb_id:
            print(f"ERROR: no notebook_id for '{args.agent}'", file=sys.stderr)
            sys.exit(2)
        print(NOTEBOOK_URL_TMPL.format(nb_id=nb_id))


def cmd_register(args) -> None:
    """Bind an existing NotebookLM notebook to a slug (notebooklm backend only)."""
    reg = load_registry()
    reg[args.agent] = {
        "backend": "notebooklm",
        "notebook_id": args.notebook,
        "title": args.title or slug_to_title(args.agent),
        "created_at": reg.get(args.agent, {}).get("created_at") or datetime.now(timezone.utc).isoformat(),
        "source_count": reg.get(args.agent, {}).get("source_count", 0),
        "registered_manually": True,
    }
    save_registry(reg)
    print(f"Registered {args.agent} -> {args.notebook} (notebooklm)")


def cmd_topics(args) -> None:
    """List topic hubs (Adoption 4)."""
    sys.path.insert(0, str(Path(__file__).parent))
    from extract_topics import list_topics
    topics = list_topics(limit=args.limit)
    if args.json:
        print(json.dumps(topics, indent=2))
        return
    if not topics:
        print("No topics extracted yet. Run an `ask` first.")
        return
    print(f"{'Slug':<35} {'Display':<30} {'Facts':<6} {'Last Seen'}")
    print("-" * 100)
    for t in topics:
        last = datetime.fromtimestamp(t["last_seen_at"], tz=timezone.utc).isoformat()[:19]
        print(f"{t['id']:<35} {t['display_name'][:29]:<30} {t['fact_count']:<6} {last}")


def cmd_topic(args) -> None:
    """Show every Q&A fact linked to a topic (Adoption 4)."""
    sys.path.insert(0, str(Path(__file__).parent))
    from extract_topics import get_topic_facts
    result = get_topic_facts(args.topic, limit=args.limit)
    if args.json:
        print(json.dumps(result, indent=2))
        return
    if not result["topic"]:
        print(f"ERROR: topic '{args.topic}' not found", file=sys.stderr)
        sys.exit(2)
    t = result["topic"]
    print(f"Topic: {t['display_name']} ({t['id']})")
    if t.get("description"):
        print(f"  {t['description']}")
    print(f"  facts: {t['fact_count']}")
    print()
    for f in result["facts"]:
        ts = datetime.fromtimestamp(f["created_at"], tz=timezone.utc).isoformat()[:19]
        q = (f.get("question") or "(no question recorded)")[:80]
        print(f"  [{ts}] {f['fact_id']}")
        print(f"    Q: {q}")
        if f.get("answer_excerpt"):
            print(f"    A: {f['answer_excerpt'][:120]}...")
        print()


def cmd_unregister(args) -> None:
    reg = load_registry()
    if args.agent in reg:
        del reg[args.agent]
        save_registry(reg)
        print(f"Unregistered {args.agent} (notebook/collection not deleted).")
    else:
        print(f"{args.agent} not in registry.")


def main() -> None:
    p = argparse.ArgumentParser(description="Per-agent research notebooks (Qdrant or NotebookLM)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_backend_flag(parser):
        parser.add_argument(
            "--backend",
            choices=["qdrant", "notebooklm"],
            default=None,
            help=f"backend to use (default: {DEFAULT_BACKEND}, or registry entry)",
        )

    ap = sub.add_parser("append", help="append a source to an agent's notebook")
    ap.add_argument("agent", help="agent slug (e.g. 'jhf-market-brief')")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--file", help="file to append as source")
    g.add_argument("--stdin", action="store_true", help="read content from stdin")
    ap.add_argument("--title", help="source title (default: filename or timestamp)")
    ap.add_argument("--tag", action="append", default=[], help="optional tag (repeatable)")
    add_backend_flag(ap)
    ap.set_defaults(func=cmd_append)

    aq = sub.add_parser("ask", help="chat with an agent's notebook")
    aq.add_argument("agent")
    aq.add_argument("--question", required=True)
    aq.add_argument("--no-citations", action="store_true",
                    help="skip persisting cited_text chunks to mimir.db")
    aq.add_argument("--no-topics", action="store_true",
                    help="skip extracting topic hubs to mimir.db")
    add_backend_flag(aq)
    aq.set_defaults(func=cmd_ask)

    at = sub.add_parser("topics", help="list topic hubs across all agent notebooks")
    at.add_argument("--limit", type=int, default=50)
    at.add_argument("--json", action="store_true")
    at.set_defaults(func=cmd_topics)

    aT = sub.add_parser("topic", help="show all Q&A facts under a topic slug")
    aT.add_argument("topic", help="topic slug (e.g. 'claude-code')")
    aT.add_argument("--limit", type=int, default=50)
    aT.add_argument("--json", action="store_true")
    aT.set_defaults(func=cmd_topic)

    al = sub.add_parser("list", help="list registered agent notebooks")
    al.set_defaults(func=cmd_list)

    au = sub.add_parser("url", help="print notebook URL or collection for an agent")
    au.add_argument("agent")
    au.set_defaults(func=cmd_url)

    ar = sub.add_parser("register", help="bind an existing NotebookLM notebook to an agent slug")
    ar.add_argument("agent")
    ar.add_argument("--notebook", required=True)
    ar.add_argument("--title")
    ar.set_defaults(func=cmd_register)

    aun = sub.add_parser("unregister", help="drop an agent from the registry")
    aun.add_argument("agent")
    aun.set_defaults(func=cmd_unregister)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
