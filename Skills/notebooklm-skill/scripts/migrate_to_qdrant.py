"""Migrate existing NotebookLM per-agent notebooks into Qdrant.

For each registry entry with backend=notebooklm (or unset), list sources in the
notebook, pull fulltext via NotebookLM's GET_SOURCE RPC, and re-append to Qdrant
through the new QdrantBackend. Leaves the original notebook intact as a fallback.

Usage:
    python3.12 migrate_to_qdrant.py              # migrate all
    python3.12 migrate_to_qdrant.py <slug>       # migrate one
    python3.12 migrate_to_qdrant.py --dry-run    # list-only, no writes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from notebooklm import NotebookLMClient  # noqa: E402
from qdrant_backend import QdrantBackend  # noqa: E402

REGISTRY_PATH = Path.home() / ".notebooklm" / "agent_notebooks.json"
STORAGE_STATE = Path.home() / ".notebooklm" / "storage_state.json"


def load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        return {}
    return json.loads(REGISTRY_PATH.read_text())


def save_registry(reg: dict) -> None:
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2, sort_keys=True))


async def migrate_slug(
    client: NotebookLMClient,
    backend: QdrantBackend,
    slug: str,
    entry: dict,
    dry_run: bool,
) -> dict:
    notebook_id = entry.get("notebook_id")
    if not notebook_id:
        return {"slug": slug, "status": "skip", "reason": "no notebook_id"}

    try:
        sources = await client.sources.list(notebook_id)
    except Exception as e:
        return {"slug": slug, "status": "error", "reason": f"list failed: {e}"}

    migrated = 0
    skipped = 0
    chunks_total = 0
    errors = []

    for src in sources:
        src_id = getattr(src, "source_id", None) or getattr(src, "id", None)
        src_title = getattr(src, "title", None) or "(untitled)"
        if not src_id:
            skipped += 1
            continue

        try:
            ft = await client.sources.get_fulltext(notebook_id, src_id)
        except Exception as e:
            errors.append(f"{src_title}: fulltext failed ({e})")
            continue

        content = ft.content or ""
        if not content.strip():
            skipped += 1
            errors.append(f"{src_title}: empty content")
            continue

        if dry_run:
            migrated += 1
            chunks_total += 1
            print(f"  [dry] {slug} ← {src_title} ({len(content)} chars)")
            continue

        result = backend.add_text(
            slug=slug,
            title=ft.title or src_title,
            content=content,
            tags=["migrated-from-notebooklm"],
        )
        migrated += 1
        chunks_total += result["chunks_added"]
        print(f"  ✓ {slug} ← {src_title} ({result['chunks_added']} chunks)")

    return {
        "slug": slug,
        "status": "ok",
        "sources_found": len(sources),
        "migrated": migrated,
        "skipped": skipped,
        "chunks": chunks_total,
        "errors": errors,
    }


async def main_async(target_slug: str | None, dry_run: bool) -> int:
    registry = load_registry()
    if not registry:
        print("Registry is empty — nothing to migrate.")
        return 0

    to_migrate = {
        s: e
        for s, e in registry.items()
        if (not target_slug or s == target_slug)
        and e.get("backend", "notebooklm") == "notebooklm"
    }

    if not to_migrate:
        print(f"No entries match (target={target_slug!r}, backend=notebooklm).")
        return 0

    print(f"Migrating {len(to_migrate)} entrie(s){' (dry-run)' if dry_run else ''}")

    if not STORAGE_STATE.exists():
        print(f"ERROR: {STORAGE_STATE} missing — re-export cookies first.", file=sys.stderr)
        return 2

    client = await NotebookLMClient.from_storage(str(STORAGE_STATE))
    backend = QdrantBackend() if not dry_run else None

    try:
        results = []
        for slug, entry in to_migrate.items():
            print(f"\n▶ {slug}  notebook={entry.get('notebook_id')}")
            r = await migrate_slug(client, backend, slug, entry, dry_run)
            results.append(r)
            if not dry_run and r["status"] == "ok" and r["migrated"] > 0:
                qdrant_slug = f"{slug}-qdrant"
                registry[qdrant_slug] = {
                    "backend": "qdrant",
                    "collection": f"agent-{slug}",
                    "created_at": entry.get("created_at"),
                    "migrated_from": entry.get("notebook_id"),
                    "source_count": r["migrated"],
                    "title": entry.get("title", slug),
                }
                save_registry(registry)
    finally:
        await client.__aexit__(None, None, None)

    print("\n── Summary ──")
    for r in results:
        print(json.dumps(r, indent=2))
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("slug", nargs="?", help="migrate only this slug")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    return asyncio.run(main_async(args.slug, args.dry_run))


if __name__ == "__main__":
    sys.exit(main())
