#!/usr/bin/env python3.12
"""Weekly Brain Dump Podcast — end-to-end orchestrator.

1. Export last N days of memory/activity → markdown brief
2. Create a new NotebookLM notebook titled "Brain Dump — YYYY-MM-DD"
3. Upload the brief as a text source
4. Generate a deep-dive audio overview (~15 min)
5. Save audio to /home/workspace/Documents/BrainDumps/
6. Emit a JSON summary on stdout with paths + notebook URL

The scheduled agent is responsible for emailing the user with the audio file.

Usage:
    python3.12 brain_dump_run.py              # Default: 7 days
    python3.12 brain_dump_run.py --days 14
    python3.12 brain_dump_run.py --dry-run    # Skip notebook/audio, just export
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
EXPORT_SCRIPT = SCRIPTS / "brain_dump_export.py"
OUTPUT_DIR = Path("/home/workspace/Documents/BrainDumps")


async def run_notebook_flow(brief_path: Path, output_dir: Path, week_label: str) -> dict:
    """Create notebook, upload source, generate audio. Returns result dict."""
    sys.path.insert(0, str(SCRIPTS))
    from notebooklm import NotebookLMClient
    from notebooklm.rpc.types import AudioFormat, AudioLength

    storage = Path.home() / ".notebooklm" / "storage_state.json"
    if not storage.exists():
        return {"error": "not_authenticated"}

    client = await NotebookLMClient.from_storage()
    await client.__aenter__()
    try:
        title = f"Brain Dump — {week_label}"
        nb = await client.notebooks.create(title=title)
        nb_id = getattr(nb, "id", str(nb))

        content = brief_path.read_text()
        await client.sources.add_text(nb_id, title=brief_path.name, content=content)

        print(f"Notebook created: {nb_id}", file=sys.stderr)
        print(f"Source uploaded: {brief_path.name} ({len(content)} chars)", file=sys.stderr)
        print(f"Generating deep-dive audio (may take 3-5 min)...", file=sys.stderr)

        status = await client.artifacts.generate_audio(
            nb_id,
            audio_format=AudioFormat.DEEP_DIVE,
            audio_length=AudioLength.DEFAULT,
            instructions=(
                "This is a personal weekly brain dump for Marland, a solo founder "
                "building across several projects. Synthesize the top 3 themes, "
                "surface patterns and cross-project connections, call out wins "
                "and blockers, and end with 3 specific recommendations for the "
                "coming week. Tone: thoughtful chief-of-staff reviewing the week "
                "with an engaged peer."
            ),
        )
        task_id = getattr(status, "task_id", None) or str(status)
        print(f"Audio task {task_id} queued, polling...", file=sys.stderr)

        try:
            await client.artifacts.wait_for_completion(nb_id, task_id, timeout=900)
        except Exception as e:
            print(f"Wait returned: {e} — attempting download anyway", file=sys.stderr)

        audio_filename = f"brain-dump-{week_label}.mp3"
        audio_path = output_dir / audio_filename
        await client.artifacts.download_audio(nb_id, str(audio_path))
        size_mb = audio_path.stat().st_size / 1024**2

        return {
            "ok": True,
            "notebook_id": nb_id,
            "notebook_url": f"https://notebooklm.google.com/notebook/{nb_id}",
            "audio_path": str(audio_path),
            "audio_size_mb": round(size_mb, 1),
            "brief_path": str(brief_path),
            "brief_chars": len(content),
        }
    finally:
        await client.__aexit__(None, None, None)


def main():
    parser = argparse.ArgumentParser(description="Weekly Brain Dump orchestrator")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true", help="Export only, skip notebook/audio")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    week_label = datetime.now(timezone.utc).date().isoformat()

    brief_path = OUTPUT_DIR / f"brain-dump-{week_label}.md"
    print(f"Exporting {args.days}-day brief to {brief_path}...", file=sys.stderr)
    result = subprocess.run(
        ["python3.12", str(EXPORT_SCRIPT), "--days", str(args.days), "--out", str(brief_path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Export failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "dry_run": True,
            "brief_path": str(brief_path),
            "brief_chars": brief_path.stat().st_size,
        }))
        return

    summary = asyncio.run(run_notebook_flow(brief_path, OUTPUT_DIR, week_label))
    if not summary.get("ok"):
        print(json.dumps(summary))
        sys.exit(1)

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
