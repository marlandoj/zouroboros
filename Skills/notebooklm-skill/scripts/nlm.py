#!/usr/bin/env python3.12
"""NotebookLM CLI wrapper for course content production.

Usage:
    python nlm.py list
    python nlm.py create-module --name "Module 1" --sources file1.md file2.md
    python nlm.py add-sources --notebook <id> --files file1.md --urls https://...
    python nlm.py generate --notebook <id> --type audio|video|cinematic-video|slide-deck|infographic|mind-map|quiz|flashcards|report|study-guide|data-table
    python nlm.py generate-all --notebook <id> --output ./output/
    python nlm.py generate-classroom --notebook <id> --output ./output/
    python nlm.py export --notebook <id> --output ./output/
    python nlm.py ask --notebook <id> --question "What is this about?"
    python nlm.py batch-modules --guides ONBOARDING_GUIDES.md --output ./output/
    python nlm.py batch-classroom --guides ONBOARDING_GUIDES.md --output ./output/
    python nlm.py import-cookies cookies.json
    python nlm.py status
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

from notebooklm import NotebookLMClient
from notebooklm.rpc.types import (
    AudioFormat, AudioLength,
    VideoFormat, VideoStyle,
    SlideDeckFormat, SlideDeckLength,
    InfographicStyle, InfographicOrientation, InfographicDetail,
    ReportFormat,
    QuizDifficulty, QuizQuantity,
)

sys.path.insert(0, str(Path(__file__).parent))
from _youtube_helper import search_videos, channel_videos  # noqa: E402


AUDIO_FORMATS = {
    "deep-dive": AudioFormat.DEEP_DIVE,
    "brief": AudioFormat.BRIEF,
    "critique": AudioFormat.CRITIQUE,
    "debate": AudioFormat.DEBATE,
}

AUDIO_LENGTHS = {
    "short": AudioLength.SHORT,
    "default": AudioLength.DEFAULT,
    "long": AudioLength.LONG,
}

VIDEO_FORMATS = {
    "explainer": VideoFormat.EXPLAINER,
    "brief": VideoFormat.BRIEF,
    "cinematic": VideoFormat.CINEMATIC,
}

VIDEO_STYLES = {
    "auto": VideoStyle.AUTO_SELECT,
    "custom": VideoStyle.CUSTOM,
    "classic": VideoStyle.CLASSIC,
    "whiteboard": VideoStyle.WHITEBOARD,
    "kawaii": VideoStyle.KAWAII,
    "anime": VideoStyle.ANIME,
    "watercolor": VideoStyle.WATERCOLOR,
    "retro-print": VideoStyle.RETRO_PRINT,
    "heritage": VideoStyle.HERITAGE,
    "paper-craft": VideoStyle.PAPER_CRAFT,
}

SLIDE_FORMATS = {
    "detailed": SlideDeckFormat.DETAILED_DECK,
    "presenter": SlideDeckFormat.PRESENTER_SLIDES,
}

SLIDE_LENGTHS = {
    "default": SlideDeckLength.DEFAULT,
    "short": SlideDeckLength.SHORT,
}

INFOGRAPHIC_STYLES = {
    "auto": InfographicStyle.AUTO_SELECT,
    "sketch-note": InfographicStyle.SKETCH_NOTE,
    "professional": InfographicStyle.PROFESSIONAL,
    "bento-grid": InfographicStyle.BENTO_GRID,
    "editorial": InfographicStyle.EDITORIAL,
    "instructional": InfographicStyle.INSTRUCTIONAL,
    "bricks": InfographicStyle.BRICKS,
    "clay": InfographicStyle.CLAY,
    "anime": InfographicStyle.ANIME,
    "kawaii": InfographicStyle.KAWAII,
    "scientific": InfographicStyle.SCIENTIFIC,
}

INFOGRAPHIC_ORIENTATIONS = {
    "landscape": InfographicOrientation.LANDSCAPE,
    "portrait": InfographicOrientation.PORTRAIT,
    "square": InfographicOrientation.SQUARE,
}

INFOGRAPHIC_DETAILS = {
    "concise": InfographicDetail.CONCISE,
    "standard": InfographicDetail.STANDARD,
    "detailed": InfographicDetail.DETAILED,
}

REPORT_FORMATS = {
    "briefing": ReportFormat.BRIEFING_DOC,
    "study-guide": ReportFormat.STUDY_GUIDE,
    "blog-post": ReportFormat.BLOG_POST,
    "custom": ReportFormat.CUSTOM,
}

QUIZ_DIFFICULTIES = {
    "easy": QuizDifficulty.EASY,
    "medium": QuizDifficulty.MEDIUM,
    "hard": QuizDifficulty.HARD,
}

QUIZ_QUANTITIES = {
    "fewer": QuizQuantity.FEWER,
    "standard": QuizQuantity.STANDARD,
}

ARTIFACT_TYPES = [
    "audio", "video", "cinematic-video", "slide-deck", "infographic",
    "mind-map", "quiz", "flashcards", "report", "study-guide", "data-table",
]

CLASSROOM_SUITE = [
    "video", "audio", "slide-deck", "infographic", "study-guide", "quiz", "flashcards",
]

FILENAMES = {
    "audio": lambda opts: f"audio-{opts.get('audio_format', 'deep-dive')}.mp3",
    "video": lambda opts: f"video-{opts.get('video_format', 'explainer')}.mp4",
    "cinematic-video": lambda opts: "video-cinematic.mp4",
    "slide-deck": lambda opts: f"slides-{opts.get('slide_format', 'detailed')}.pdf",
    "infographic": lambda opts: f"infographic-{opts.get('infographic_style', 'professional')}.png",
    "mind-map": lambda opts: "mind-map.png",
    "quiz": lambda opts: "quiz.json",
    "flashcards": lambda opts: "flashcards.json",
    "report": lambda opts: f"report-{opts.get('report_format', 'briefing')}.md",
    "study-guide": lambda opts: "study-guide.md",
    "data-table": lambda opts: "data-table.json",
}


async def get_client():
    storage = Path.home() / ".notebooklm" / "storage_state.json"
    if not storage.exists():
        print("ERROR: Not authenticated. Run 'notebooklm login' or use 'nlm.py import-cookies'.", file=sys.stderr)
        sys.exit(1)
    client = await NotebookLMClient.from_storage()
    await client.__aenter__()
    return client


async def cmd_list(args):
    client = await get_client()
    try:
        notebooks = await client.notebooks.list()
        if not notebooks:
            print("No notebooks found.")
            return
        print(f"{'ID':<40} {'Title':<50} {'Sources'}")
        print("-" * 100)
        for nb in notebooks:
            title = getattr(nb, "title", "Untitled") or "Untitled"
            nb_id = getattr(nb, "id", str(nb))
            source_count = getattr(nb, "source_count", "?")
            print(f"{nb_id:<40} {title:<50} {source_count}")
    finally:
        await client.__aexit__(None, None, None)


async def cmd_status(args):
    client = await get_client()
    try:
        notebooks = await client.notebooks.list()
        print(f"Authenticated: yes")
        print(f"Notebooks: {len(notebooks)}")
    finally:
        await client.__aexit__(None, None, None)


async def cmd_create_module(args):
    client = await get_client()
    try:
        nb = await client.notebooks.create(title=args.name)
        nb_id = getattr(nb, "id", str(nb))
        print(f"Created notebook: {nb_id} — {args.name}")

        if args.sources:
            for src in args.sources:
                path = Path(src)
                if path.exists():
                    if path.suffix in (".md", ".txt"):
                        content = path.read_text()
                        await client.sources.add_text(nb_id, title=path.name, content=content)
                        print(f"  Added text source: {path.name}")
                    else:
                        await client.sources.add_file(nb_id, str(path))
                        print(f"  Uploaded file: {path.name}")
                elif src.startswith("http"):
                    if "youtube.com" in src or "youtu.be" in src:
                        await client.sources.add_youtube(nb_id, src)
                    else:
                        await client.sources.add_url(nb_id, src)
                    print(f"  Added URL: {src}")
                else:
                    print(f"  WARNING: Source not found: {src}", file=sys.stderr)

        print(f"\nNotebook ready: {nb_id}")
        return nb_id
    finally:
        await client.__aexit__(None, None, None)


async def cmd_add_sources(args):
    client = await get_client()
    try:
        nb_id = args.notebook
        if args.files:
            for f in args.files:
                path = Path(f)
                if path.exists():
                    if path.suffix in (".md", ".txt"):
                        content = path.read_text()
                        await client.sources.add_text(nb_id, title=path.name, content=content)
                    else:
                        await client.sources.add_file(nb_id, str(path))
                    print(f"Added: {path.name}")
                else:
                    print(f"Not found: {f}", file=sys.stderr)
        if args.urls:
            for url in args.urls:
                if "youtube.com" in url or "youtu.be" in url:
                    await client.sources.add_youtube(nb_id, url)
                else:
                    await client.sources.add_url(nb_id, url)
                print(f"Added URL: {url}")
    finally:
        await client.__aexit__(None, None, None)


async def _generate_artifact(client, nb_id, artifact_type, opts=None):
    """Start generation for an artifact type. Returns GenerationStatus with task_id."""
    opts = opts or {}
    instructions = opts.get("instructions")
    source_ids = opts.get("source_ids")

    if artifact_type == "audio":
        return await client.artifacts.generate_audio(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
            audio_format=AUDIO_FORMATS.get(opts.get("audio_format", "deep-dive"), AudioFormat.DEEP_DIVE),
            audio_length=AUDIO_LENGTHS.get(opts.get("audio_length", "default"), AudioLength.DEFAULT),
        )
    elif artifact_type == "video":
        return await client.artifacts.generate_video(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
            video_format=VIDEO_FORMATS.get(opts.get("video_format", "explainer"), VideoFormat.EXPLAINER),
            video_style=VIDEO_STYLES.get(opts.get("video_style", "auto"), VideoStyle.AUTO_SELECT),
        )
    elif artifact_type == "cinematic-video":
        return await client.artifacts.generate_cinematic_video(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
        )
    elif artifact_type == "slide-deck":
        return await client.artifacts.generate_slide_deck(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
            slide_format=SLIDE_FORMATS.get(opts.get("slide_format", "detailed"), SlideDeckFormat.DETAILED_DECK),
            slide_length=SLIDE_LENGTHS.get(opts.get("slide_length", "default"), SlideDeckLength.DEFAULT),
        )
    elif artifact_type == "infographic":
        return await client.artifacts.generate_infographic(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
            style=INFOGRAPHIC_STYLES.get(opts.get("infographic_style", "professional"), InfographicStyle.PROFESSIONAL),
            orientation=INFOGRAPHIC_ORIENTATIONS.get(opts.get("infographic_orientation", "landscape"), InfographicOrientation.LANDSCAPE),
            detail_level=INFOGRAPHIC_DETAILS.get(opts.get("infographic_detail", "standard"), InfographicDetail.STANDARD),
        )
    elif artifact_type == "mind-map":
        return await client.artifacts.generate_mind_map(nb_id, source_ids=source_ids)
    elif artifact_type == "quiz":
        return await client.artifacts.generate_quiz(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
            difficulty=QUIZ_DIFFICULTIES.get(opts.get("quiz_difficulty", "medium"), QuizDifficulty.MEDIUM),
            quantity=QUIZ_QUANTITIES.get(opts.get("quiz_quantity", "standard"), QuizQuantity.STANDARD),
        )
    elif artifact_type == "flashcards":
        return await client.artifacts.generate_flashcards(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
            difficulty=QUIZ_DIFFICULTIES.get(opts.get("quiz_difficulty", "medium"), QuizDifficulty.MEDIUM),
            quantity=QUIZ_QUANTITIES.get(opts.get("quiz_quantity", "standard"), QuizQuantity.STANDARD),
        )
    elif artifact_type == "report":
        fmt = REPORT_FORMATS.get(opts.get("report_format", "briefing"), ReportFormat.BRIEFING_DOC)
        return await client.artifacts.generate_report(
            nb_id,
            report_format=fmt,
            source_ids=source_ids,
            custom_prompt=opts.get("custom_prompt") if fmt == ReportFormat.CUSTOM else None,
            extra_instructions=instructions,
        )
    elif artifact_type == "study-guide":
        return await client.artifacts.generate_study_guide(
            nb_id,
            source_ids=source_ids,
            extra_instructions=instructions,
        )
    elif artifact_type == "data-table":
        return await client.artifacts.generate_data_table(
            nb_id,
            source_ids=source_ids,
            instructions=instructions,
        )
    else:
        raise ValueError(f"Unknown artifact type: {artifact_type}")


async def _download_artifact(client, nb_id, artifact_type, output_path, artifact_id=None):
    """Download a completed artifact to disk."""
    downloaders = {
        "audio": client.artifacts.download_audio,
        "video": client.artifacts.download_video,
        "cinematic-video": client.artifacts.download_video,
        "slide-deck": client.artifacts.download_slide_deck,
        "infographic": client.artifacts.download_infographic,
        "mind-map": client.artifacts.download_mind_map,
        "quiz": client.artifacts.download_quiz,
        "flashcards": client.artifacts.download_flashcards,
        "report": client.artifacts.download_report,
        "study-guide": client.artifacts.download_report,
        "data-table": client.artifacts.download_data_table,
    }
    dl = downloaders[artifact_type]
    if artifact_id:
        return await dl(nb_id, output_path, artifact_id=artifact_id)
    return await dl(nb_id, output_path)


async def _generate_and_download(client, nb_id, artifact_type, output_dir, opts=None, timeout=600):
    """Generate an artifact, wait for completion, and download. Returns output path or None."""
    opts = opts or {}
    filename = FILENAMES[artifact_type](opts)
    out_path = str(output_dir / filename)

    print(f"  [{artifact_type}] Starting generation...", flush=True)
    start = time.time()

    status = await _generate_artifact(client, nb_id, artifact_type, opts)

    # mind-map returns dict directly (no async generation)
    if artifact_type == "mind-map" and isinstance(status, dict):
        Path(out_path).write_text(json.dumps(status, indent=2))
        elapsed = int(time.time() - start)
        print(f"  [{artifact_type}] Done in {elapsed}s → {out_path}", flush=True)
        return out_path

    task_id = getattr(status, "task_id", None) or str(status)
    print(f"  [{artifact_type}] Task {task_id} queued, polling...", flush=True)

    try:
        await client.artifacts.wait_for_completion(nb_id, task_id, timeout=timeout)
    except (TimeoutError, Exception) as e:
        elapsed = int(time.time() - start)
        if "timeout" in str(e).lower() or isinstance(e, TimeoutError):
            print(f"  [{artifact_type}] Still generating after {elapsed}s. Downloading anyway...", flush=True)
        else:
            print(f"  [{artifact_type}] Wait error ({e}), attempting download...", flush=True)

    try:
        await _download_artifact(client, nb_id, artifact_type, out_path)
        size = Path(out_path).stat().st_size if Path(out_path).exists() else 0
        elapsed = int(time.time() - start)
        print(f"  [{artifact_type}] Done in {elapsed}s → {out_path} ({_fmt_size(size)})", flush=True)
        return out_path
    except Exception as e:
        elapsed = int(time.time() - start)
        print(f"  [{artifact_type}] Download failed after {elapsed}s: {e}", file=sys.stderr, flush=True)
        return None


def _fmt_size(b):
    if b < 1024: return f"{b} B"
    if b < 1024**2: return f"{b/1024:.1f} KB"
    return f"{b/1024**2:.1f} MB"


async def cmd_generate(args):
    client = await get_client()
    try:
        nb_id = args.notebook
        artifact_type = args.type
        output_dir = Path(args.output) if args.output else Path("./output")
        output_dir.mkdir(parents=True, exist_ok=True)

        opts = {
            "instructions": args.instructions,
            "audio_format": args.audio_format,
            "audio_length": args.audio_length,
            "video_format": args.video_format,
            "video_style": args.video_style,
            "slide_format": args.slide_format,
            "slide_length": args.slide_length,
            "infographic_style": args.infographic_style,
            "infographic_orientation": args.infographic_orientation,
            "infographic_detail": args.infographic_detail,
            "report_format": args.report_format,
            "custom_prompt": args.custom_prompt,
            "quiz_difficulty": args.quiz_difficulty,
            "quiz_quantity": args.quiz_quantity,
        }

        print(f"Generating {artifact_type} for notebook {nb_id}...")
        out_path = await _generate_and_download(client, nb_id, artifact_type, output_dir, opts, timeout=args.timeout)
        if out_path:
            print(f"\nSaved: {out_path}")
        else:
            print(f"\nGeneration failed or timed out.", file=sys.stderr)
    finally:
        await client.__aexit__(None, None, None)


async def cmd_generate_all(args):
    """Generate all artifact types (kitchen sink)."""
    client = await get_client()
    try:
        nb_id = args.notebook
        output_dir = Path(args.output) if args.output else Path("./output")
        output_dir.mkdir(parents=True, exist_ok=True)

        types_to_gen = ["audio", "video", "slide-deck", "infographic", "mind-map", "quiz", "flashcards", "report", "study-guide"]
        if args.include_data_table:
            types_to_gen.append("data-table")

        opts = {"instructions": args.instructions}
        results = {}
        for t in types_to_gen:
            print(f"\n--- {t} ---")
            try:
                out = await _generate_and_download(client, nb_id, t, output_dir, opts, timeout=args.timeout)
                results[t] = out
            except Exception as e:
                print(f"  ERROR: {e}", file=sys.stderr)
                results[t] = None

        print(f"\n{'='*60}")
        print(f"Results:")
        for t, path in results.items():
            status = f"✓ {path}" if path else "✗ failed"
            print(f"  {t:<20} {status}")
        print(f"\nOutput: {output_dir}")
    finally:
        await client.__aexit__(None, None, None)


async def cmd_generate_classroom(args):
    """Generate the ideal Skool classroom content suite per module."""
    client = await get_client()
    try:
        nb_id = args.notebook
        output_dir = Path(args.output) if args.output else Path("./output")
        output_dir.mkdir(parents=True, exist_ok=True)

        suite = list(CLASSROOM_SUITE)
        classroom_opts = {
            "instructions": args.instructions,
            "video_format": "explainer",
            "video_style": args.video_style or "classic",
            "audio_format": "deep-dive",
            "audio_length": "default",
            "slide_format": "detailed",
            "infographic_style": args.infographic_style or "professional",
            "infographic_orientation": "landscape",
            "infographic_detail": "standard",
            "quiz_difficulty": "medium",
            "quiz_quantity": "standard",
        }

        print(f"Generating classroom suite for notebook {nb_id}")
        print(f"Suite: {', '.join(suite)}\n")

        results = {}
        for t in suite:
            print(f"--- {t} ---")
            try:
                out = await _generate_and_download(client, nb_id, t, output_dir, classroom_opts, timeout=args.timeout)
                results[t] = out
            except Exception as e:
                print(f"  ERROR: {e}", file=sys.stderr)
                results[t] = None

        print(f"\n{'='*60}")
        print(f"Classroom Suite Results:")
        for t, path in results.items():
            status = f"✓ {path}" if path else "✗ failed"
            print(f"  {t:<20} {status}")
        print(f"\nOutput: {output_dir}")
    finally:
        await client.__aexit__(None, None, None)


async def cmd_ask(args):
    client = await get_client()
    try:
        result = await client.chat.ask(args.notebook, args.question)
        print(result)
    finally:
        await client.__aexit__(None, None, None)


def split_guides_into_modules(guides_path: str) -> list[dict]:
    content = Path(guides_path).read_text()
    modules = []
    sections = re.split(r'\n## (Guide \d+: .+)\n', content)
    for i in range(1, len(sections), 2):
        title = sections[i].strip()
        body = sections[i + 1].strip() if i + 1 < len(sections) else ""
        module_num = re.search(r'Guide (\d+)', title)
        num = module_num.group(1) if module_num else str(len(modules) + 1)
        modules.append({"number": num, "title": title, "content": f"# {title}\n\n{body}"})
    return modules


async def cmd_batch_modules(args):
    """Create notebooks and generate basic artifacts for all modules."""
    guides_path = args.guides
    output_base = Path(args.output) if args.output else Path("./output")
    modules = split_guides_into_modules(guides_path)
    if not modules:
        print("ERROR: No modules found in guides file.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(modules)} modules to process.\n")
    client = await get_client()
    try:
        for mod in modules:
            module_dir = output_base / f"module-{mod['number']}"
            module_dir.mkdir(parents=True, exist_ok=True)
            src_file = module_dir / "source.md"
            src_file.write_text(mod["content"])

            print(f"\n{'='*60}")
            print(f"Module {mod['number']}: {mod['title']}")
            print(f"{'='*60}")

            nb = await client.notebooks.create(title=f"Zouroboros Academy — {mod['title']}")
            nb_id = getattr(nb, "id", str(nb))
            print(f"  Created notebook: {nb_id}")

            await client.sources.add_text(nb_id, title=f"Guide {mod['number']}", content=mod["content"])
            print(f"  Added source text ({len(mod['content'])} chars)")

            if args.extra_sources:
                for src in args.extra_sources:
                    path = Path(src)
                    if path.exists():
                        content = path.read_text()
                        await client.sources.add_text(nb_id, title=path.name, content=content)
                        print(f"  Added extra source: {path.name}")

            for artifact_type in ["audio", "quiz", "flashcards"]:
                try:
                    out = await _generate_and_download(client, nb_id, artifact_type, module_dir)
                except Exception as e:
                    print(f"  ✗ {artifact_type}: {e}", file=sys.stderr)

            (module_dir / "notebook_id.txt").write_text(nb_id)
            print(f"  Output: {module_dir}")

        print(f"\n{'='*60}")
        print(f"Batch complete. {len(modules)} modules processed.")
        print(f"Output: {output_base}")
    finally:
        await client.__aexit__(None, None, None)


async def cmd_batch_classroom(args):
    """Create notebooks and generate full classroom suite for all modules."""
    guides_path = args.guides
    output_base = Path(args.output) if args.output else Path("./output")
    modules = split_guides_into_modules(guides_path)
    if not modules:
        print("ERROR: No modules found in guides file.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(modules)} modules. Generating classroom suite for each.\n")

    classroom_opts = {
        "video_format": "explainer",
        "video_style": args.video_style or "classic",
        "audio_format": "deep-dive",
        "audio_length": "default",
        "slide_format": "detailed",
        "infographic_style": args.infographic_style or "professional",
        "infographic_orientation": "landscape",
        "infographic_detail": "standard",
        "quiz_difficulty": "medium",
        "quiz_quantity": "standard",
        "instructions": args.instructions,
    }

    client = await get_client()
    try:
        for mod in modules:
            module_dir = output_base / f"module-{mod['number']}"
            module_dir.mkdir(parents=True, exist_ok=True)
            src_file = module_dir / "source.md"
            src_file.write_text(mod["content"])

            print(f"\n{'='*60}")
            print(f"Module {mod['number']}: {mod['title']}")
            print(f"{'='*60}")

            nb = await client.notebooks.create(title=f"Zouroboros Academy — {mod['title']}")
            nb_id = getattr(nb, "id", str(nb))
            print(f"  Created notebook: {nb_id}")

            await client.sources.add_text(nb_id, title=f"Guide {mod['number']}", content=mod["content"])
            print(f"  Added source text ({len(mod['content'])} chars)")

            if args.extra_sources:
                for src in args.extra_sources:
                    path = Path(src)
                    if path.exists():
                        content = path.read_text()
                        await client.sources.add_text(nb_id, title=path.name, content=content)
                        print(f"  Added extra source: {path.name}")

            results = {}
            for artifact_type in CLASSROOM_SUITE:
                try:
                    out = await _generate_and_download(client, nb_id, artifact_type, module_dir, classroom_opts)
                    results[artifact_type] = out
                except Exception as e:
                    print(f"  ✗ {artifact_type}: {e}", file=sys.stderr)
                    results[artifact_type] = None

            (module_dir / "notebook_id.txt").write_text(nb_id)
            manifest = {
                "module": mod["number"],
                "title": mod["title"],
                "notebook_id": nb_id,
                "artifacts": {k: v for k, v in results.items()},
            }
            (module_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
            print(f"  Output: {module_dir}")

        print(f"\n{'='*60}")
        print(f"Classroom batch complete. {len(modules)} modules processed.")
        print(f"Output: {output_base}")
    finally:
        await client.__aexit__(None, None, None)


async def cmd_export(args):
    """Export/download all available artifacts from a notebook."""
    client = await get_client()
    try:
        nb_id = args.notebook
        output_dir = Path(args.output) if args.output else Path("./output")
        output_dir.mkdir(parents=True, exist_ok=True)

        for artifact_type in ["audio", "video", "slide-deck", "infographic", "mind-map", "quiz", "flashcards", "report"]:
            filename = FILENAMES[artifact_type]({})
            out_path = str(output_dir / filename)
            try:
                await _download_artifact(client, nb_id, artifact_type, out_path)
                size = Path(out_path).stat().st_size if Path(out_path).exists() else 0
                if size > 0:
                    print(f"  ✓ {artifact_type} → {out_path} ({_fmt_size(size)})")
                else:
                    Path(out_path).unlink(missing_ok=True)
            except Exception:
                Path(out_path).unlink(missing_ok=True)

        print(f"\nExport complete: {output_dir}")
    finally:
        await client.__aexit__(None, None, None)


def cmd_import_cookies(args):
    """Convert Cookie-Editor JSON export to notebooklm-py storage_state.json."""
    cookies_path = Path(args.cookies_file)
    if not cookies_path.exists():
        print(f"ERROR: File not found: {cookies_path}", file=sys.stderr)
        sys.exit(1)

    raw = json.loads(cookies_path.read_text())
    playwright_cookies = []
    for c in raw:
        name = c.get("name", "")
        pc = {
            "name": name,
            "value": c.get("value", ""),
            "domain": c.get("domain", ""),
            "path": c.get("path", "/"),
            "httpOnly": c.get("httpOnly", False),
            "secure": c.get("secure", False),
        }
        same_site = c.get("sameSite", "unspecified")
        if same_site == "no_restriction":
            pc["sameSite"] = "None"
        elif same_site == "lax":
            pc["sameSite"] = "Lax"
        elif same_site == "strict":
            pc["sameSite"] = "Strict"

        if c.get("expirationDate"):
            pc["expires"] = c["expirationDate"]

        playwright_cookies.append(pc)

    storage_state = {
        "cookies": playwright_cookies,
        "origins": [
            {"origin": "https://notebooklm.google.com", "localStorage": []},
        ],
    }

    dest = Path.home() / ".notebooklm" / "storage_state.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(storage_state, indent=2))
    print(f"Imported {len(playwright_cookies)} cookies → {dest}")

    critical = {"SID", "HSID", "SSID", "OSID", "__Secure-OSID", "__Secure-1PSID", "__Secure-3PSID"}
    found = {c["name"] for c in playwright_cookies}
    missing = critical - found
    if missing:
        print(f"\nWARNING: Missing critical cookies: {', '.join(sorted(missing))}", file=sys.stderr)
        print("Auth may fail. Re-export cookies while on notebooklm.google.com.", file=sys.stderr)
    else:
        print("All critical cookies present. ✓")


def cmd_search(args):
    """Search YouTube via yt-dlp (no auth)."""
    results = search_videos(args.query, args.limit)
    if args.json:
        print(json.dumps(results, indent=2))
        return
    if not results:
        print("(no results)")
        return
    for v in results:
        dur = f"{v['duration_s']//60}:{v['duration_s']%60:02d}" if v.get("duration_s") else "—"
        title = v["title"][:80]
        print(f"  [{dur:>5}] {title}")
        print(f"          {v['channel']}  {v['url']}")


def _video_to_chunk(v: dict, transcript: str | None) -> str:
    """Build the searchable text body Qdrant will embed for one video."""
    dur = f"{v['duration_s']//60}:{v['duration_s']%60:02d}" if v.get("duration_s") else "—"
    upload = v.get("upload_date") or "unknown"
    body = (
        f"Title: {v['title']}\n"
        f"Channel: {v.get('channel') or 'unknown'}\n"
        f"Duration: {dur}\n"
        f"Upload date: {upload}\n"
        f"URL: {v['url']}\n"
    )
    if transcript:
        body += f"\nTranscript:\n{transcript}\n"
    return body


async def _load_channel_qdrant(args, videos):
    """Qdrant ingest path: best-effort transcript per video, fall back to metadata."""
    from qdrant_backend import QdrantBackend
    from _youtube_helper import fetch_transcript

    backend = QdrantBackend()
    slug = args.slug
    added = 0
    skipped = 0
    with_transcript = 0

    for v in videos:
        try:
            transcript = fetch_transcript(v["url"])
        except Exception:
            transcript = None
        if transcript:
            with_transcript += 1
        body = _video_to_chunk(v, transcript)
        try:
            backend.add_text(
                slug=slug,
                title=v["title"][:200] or v["url"],
                content=body,
                tags=["youtube", v.get("channel") or "unknown"],
            )
            added += 1
            mark = "T" if transcript else "m"  # T=transcript, m=metadata-only
            print(f"  ✓[{mark}] {v['title'][:70]}")
        except Exception as e:
            skipped += 1
            print(f"  ✗ {v['title'][:70]} — {e}", file=sys.stderr)

    print(
        f"\nDone: {added} ingested into agent-{slug} "
        f"({with_transcript} with transcript, {added - with_transcript} metadata-only), "
        f"{skipped} skipped."
    )


async def cmd_load_channel(args):
    """Bulk-add a channel's recent videos.

    Default: NotebookLM upload (requires valid Google session).
    --qdrant: ingest into a local Qdrant collection (no auth, transcripts best-effort).
    """
    videos = channel_videos(args.url, args.limit)
    if not videos:
        print(f"No videos found at {args.url}", file=sys.stderr)
        sys.exit(1)
    print(f"Found {len(videos)} videos.")

    if args.qdrant:
        if not args.slug:
            print("--qdrant requires --slug <agent-slug>", file=sys.stderr)
            sys.exit(2)
        print(f"Ingesting into Qdrant collection 'agent-{args.slug}'...")
        await _load_channel_qdrant(args, videos)
        return

    print(f"Adding to notebook {args.notebook}...")
    client = await get_client()
    sem = asyncio.Semaphore(args.concurrency)
    added = 0
    failed = 0

    async def _add(v):
        nonlocal added, failed
        async with sem:
            try:
                await client.sources.add_youtube(args.notebook, v["url"])
                added += 1
                print(f"  ✓ {v['title'][:70]}")
            except Exception as e:
                failed += 1
                print(f"  ✗ {v['title'][:70]} — {e}", file=sys.stderr)

    try:
        await asyncio.gather(*(_add(v) for v in videos))
    finally:
        await client.__aexit__(None, None, None)

    print(f"\nDone: {added} added, {failed} failed.")


def main():
    parser = argparse.ArgumentParser(description="NotebookLM course content CLI — full Studio toolkit")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List all notebooks")
    sub.add_parser("status", help="Show auth and notebook status")

    # create-module
    p_create = sub.add_parser("create-module", help="Create a notebook for a module")
    p_create.add_argument("--name", required=True, help="Module name/title")
    p_create.add_argument("--sources", nargs="*", help="Source files or URLs to add")

    # add-sources
    p_add = sub.add_parser("add-sources", help="Add sources to an existing notebook")
    p_add.add_argument("--notebook", required=True, help="Notebook ID")
    p_add.add_argument("--files", nargs="*", help="Local files to add")
    p_add.add_argument("--urls", nargs="*", help="URLs to add")

    # generate (single artifact)
    p_gen = sub.add_parser("generate", help="Generate a specific artifact type")
    p_gen.add_argument("--notebook", required=True, help="Notebook ID")
    p_gen.add_argument("--type", required=True, choices=ARTIFACT_TYPES, help="Artifact type")
    p_gen.add_argument("--output", help="Output directory")
    p_gen.add_argument("--instructions", help="Custom instructions for generation")
    p_gen.add_argument("--timeout", type=int, default=600, help="Timeout in seconds (default: 600)")
    # Audio options
    p_gen.add_argument("--audio-format", choices=list(AUDIO_FORMATS.keys()), default="deep-dive")
    p_gen.add_argument("--audio-length", choices=list(AUDIO_LENGTHS.keys()), default="default")
    # Video options
    p_gen.add_argument("--video-format", choices=list(VIDEO_FORMATS.keys()), default="explainer")
    p_gen.add_argument("--video-style", choices=list(VIDEO_STYLES.keys()), default="auto")
    # Slide options
    p_gen.add_argument("--slide-format", choices=list(SLIDE_FORMATS.keys()), default="detailed")
    p_gen.add_argument("--slide-length", choices=list(SLIDE_LENGTHS.keys()), default="default")
    # Infographic options
    p_gen.add_argument("--infographic-style", choices=list(INFOGRAPHIC_STYLES.keys()), default="professional")
    p_gen.add_argument("--infographic-orientation", choices=list(INFOGRAPHIC_ORIENTATIONS.keys()), default="landscape")
    p_gen.add_argument("--infographic-detail", choices=list(INFOGRAPHIC_DETAILS.keys()), default="standard")
    # Report options
    p_gen.add_argument("--report-format", choices=list(REPORT_FORMATS.keys()), default="briefing")
    p_gen.add_argument("--custom-prompt", help="Custom prompt for report (only with --report-format custom)")
    # Quiz/flashcard options
    p_gen.add_argument("--quiz-difficulty", choices=list(QUIZ_DIFFICULTIES.keys()), default="medium")
    p_gen.add_argument("--quiz-quantity", choices=list(QUIZ_QUANTITIES.keys()), default="standard")

    # generate-all (kitchen sink)
    p_all = sub.add_parser("generate-all", help="Generate all artifact types for a notebook")
    p_all.add_argument("--notebook", required=True, help="Notebook ID")
    p_all.add_argument("--output", help="Output directory")
    p_all.add_argument("--instructions", help="Custom instructions for all generators")
    p_all.add_argument("--timeout", type=int, default=600, help="Timeout per artifact (default: 600)")
    p_all.add_argument("--include-data-table", action="store_true", help="Also generate data table")

    # generate-classroom (Skool-optimized suite)
    p_class = sub.add_parser("generate-classroom", help="Generate Skool classroom suite (video + audio + slides + infographic + study guide + quiz + flashcards)")
    p_class.add_argument("--notebook", required=True, help="Notebook ID")
    p_class.add_argument("--output", help="Output directory")
    p_class.add_argument("--instructions", help="Custom instructions for all generators")
    p_class.add_argument("--video-style", choices=list(VIDEO_STYLES.keys()), default="classic")
    p_class.add_argument("--infographic-style", choices=list(INFOGRAPHIC_STYLES.keys()), default="professional")
    p_class.add_argument("--timeout", type=int, default=600, help="Timeout per artifact (default: 600)")

    # export
    p_export = sub.add_parser("export", help="Download all available artifacts from a notebook")
    p_export.add_argument("--notebook", required=True, help="Notebook ID")
    p_export.add_argument("--output", help="Output directory")

    # ask
    p_ask = sub.add_parser("ask", help="Ask a question to a notebook")
    p_ask.add_argument("--notebook", required=True, help="Notebook ID")
    p_ask.add_argument("--question", required=True, help="Question to ask")

    # batch-modules (basic)
    p_batch = sub.add_parser("batch-modules", help="Batch process all modules (audio + quiz + flashcards)")
    p_batch.add_argument("--guides", required=True, help="Path to ONBOARDING_GUIDES.md")
    p_batch.add_argument("--output", default="./output", help="Base output directory")
    p_batch.add_argument("--extra-sources", nargs="*", help="Additional source files for all modules")

    # batch-classroom (full suite)
    p_bclass = sub.add_parser("batch-classroom", help="Batch process all modules with full classroom suite")
    p_bclass.add_argument("--guides", required=True, help="Path to ONBOARDING_GUIDES.md")
    p_bclass.add_argument("--output", default="./output", help="Base output directory")
    p_bclass.add_argument("--extra-sources", nargs="*", help="Additional source files for all modules")
    p_bclass.add_argument("--instructions", help="Custom instructions for all generators")
    p_bclass.add_argument("--video-style", choices=list(VIDEO_STYLES.keys()), default="classic")
    p_bclass.add_argument("--infographic-style", choices=list(INFOGRAPHIC_STYLES.keys()), default="professional")
    p_bclass.add_argument("--timeout", type=int, default=600, help="Timeout per artifact (default: 600)")

    # import-cookies
    p_cookies = sub.add_parser("import-cookies", help="Import cookies from Cookie-Editor JSON export")
    p_cookies.add_argument("cookies_file", help="Path to exported cookies JSON file")

    # search (YouTube — no auth, yt-dlp)
    p_search = sub.add_parser("search", help="Search YouTube (yt-dlp, no auth)")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("-n", "--limit", type=int, default=10, help="Max results (default: 10)")
    p_search.add_argument("--json", action="store_true", help="Output raw JSON")

    # load-channel (bulk YouTube ingestion into a notebook OR Qdrant collection)
    p_chan = sub.add_parser(
        "load-channel",
        help="Bulk add a YouTube channel's videos to a notebook (--notebook) or Qdrant (--qdrant --slug)",
    )
    p_chan.add_argument("url", help="Channel URL (/@handle, /channel/UC..., /c/Name)")
    p_chan.add_argument("--notebook", help="Target notebook ID (required unless --qdrant)")
    p_chan.add_argument("--qdrant", action="store_true", help="Route to local Qdrant instead of NotebookLM (no Google auth required)")
    p_chan.add_argument("--slug", help="Agent slug for Qdrant collection (required with --qdrant)")
    p_chan.add_argument("--limit", type=int, default=250, help="Max videos to add (default: 250)")
    p_chan.add_argument("--concurrency", type=int, default=5, help="Parallel add requests, NotebookLM only (default: 5)")

    args = parser.parse_args()
    cmd_map = {
        "list": cmd_list,
        "status": cmd_status,
        "create-module": cmd_create_module,
        "add-sources": cmd_add_sources,
        "generate": cmd_generate,
        "generate-all": cmd_generate_all,
        "generate-classroom": cmd_generate_classroom,
        "ask": cmd_ask,
        "export": cmd_export,
        "batch-modules": cmd_batch_modules,
        "batch-classroom": cmd_batch_classroom,
        "load-channel": cmd_load_channel,
    }

    if args.command == "import-cookies":
        cmd_import_cookies(args)
    elif args.command == "search":
        cmd_search(args)
    else:
        asyncio.run(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
