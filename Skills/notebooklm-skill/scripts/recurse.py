#!/usr/bin/env python3.12
"""Adversarial Debate recursion prototype.

Flow:
  1. Create NotebookLM notebook with draft + adversarial Critic Brief
  2. Generate debate audio with explicit adversarial instructions
  3. Download audio, transcribe via OpenAI Whisper API
  4. Extract objections (structured output) from transcript
  5. Write objections to shared memory as facts with source=notebooklm-critique

Usage:
    python3.12 recurse.py --draft path/to/draft.md [--iteration 1] [--output ./out]
"""
import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from notebooklm import NotebookLMClient
from notebooklm.rpc.types import AudioFormat, AudioLength

from openai import OpenAI


CRITIC_BRIEF = """# Critic Brief — Adversarial Review Framing

You are a two-host debate panel with opposing mandates.

**Host A (Advocate):** Steelman the draft. Quote its strongest claims, explain
why they matter, and note where evidence is solid.

**Host B (Adversary):** Attack the draft. Your job is to find every weakness:
- **Factual errors** — claims that are wrong, unsupported, or cite bad data
- **Structural gaps** — missing steps, logical jumps, undefended assumptions
- **Stylistic issues** — unclear phrasing, buried leads, hedging
- **Adversarial angles** — how a hostile reader would misread, weaponize, or
  dismiss this draft; what objections a skeptic would raise

Do not synthesize. Do not resolve. The goal is to surface as many concrete,
quotable objections as possible. Each objection should reference a specific
passage or claim from the draft. Be specific. Be ruthless. Be fair.

Length: go long. Every unexplored weakness is a failure.
"""

AUDIO_INSTRUCTIONS = """Conduct an adversarial debate-style review. One host
steelmans; one host attacks. Surface concrete, quotable objections across four
categories: factual errors, structural gaps, stylistic issues, and adversarial
angles. Reference specific passages. Do not resolve or synthesize — the goal is
to enumerate weaknesses."""

EXTRACTION_SYSTEM = """You extract structured objections from an adversarial
debate transcript. Return ONLY objections — not steelman points. Each objection
must be specific and quotable."""

EXTRACTION_USER_TEMPLATE = """Transcript of an adversarial debate about a draft:

{transcript}

Extract every concrete objection the Adversary (or either host when they
critique) raises against the draft. Return JSON matching the schema."""


async def build_notebook(client, draft_path: Path, title_prefix: str) -> str:
    title = f"{title_prefix} — {draft_path.stem}"
    nb = await client.notebooks.create(title=title)
    nb_id = getattr(nb, "id", str(nb))
    print(f"[notebook] Created: {nb_id} — {title}", flush=True)

    draft_content = draft_path.read_text()
    await client.sources.add_text(nb_id, title=f"DRAFT — {draft_path.name}", content=draft_content)
    print(f"[notebook] Added draft source ({len(draft_content)} chars)", flush=True)

    await client.sources.add_text(nb_id, title="Critic Brief (adversarial framing)", content=CRITIC_BRIEF)
    print(f"[notebook] Added critic brief source", flush=True)

    return nb_id


async def generate_debate_audio(client, nb_id: str, output_path: Path, timeout: int = 900) -> Path:
    print(f"[audio] Starting DEBATE generation (timeout {timeout}s)...", flush=True)
    start = time.time()
    status = await client.artifacts.generate_audio(
        nb_id,
        instructions=AUDIO_INSTRUCTIONS,
        audio_format=AudioFormat.DEBATE,
        audio_length=AudioLength.DEFAULT,
    )
    task_id = getattr(status, "task_id", None) or str(status)
    print(f"[audio] Task {task_id} queued, polling...", flush=True)

    await client.artifacts.wait_for_completion(nb_id, task_id, timeout=timeout)
    elapsed = int(time.time() - start)
    print(f"[audio] Completed in {elapsed}s, downloading...", flush=True)

    await client.artifacts.download_audio(nb_id, str(output_path))
    size_mb = output_path.stat().st_size / 1_048_576
    print(f"[audio] Saved {size_mb:.1f} MB → {output_path}", flush=True)
    return output_path


WHISPER_SIZE_LIMIT = 24 * 1024 * 1024  # 24 MB buffer under 25 MB cap
CHUNK_SECONDS = 600  # 10 min chunks


def _ffprobe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def _chunk_audio(audio_path: Path, chunk_seconds: int) -> list[Path]:
    duration = _ffprobe_duration(audio_path)
    n = int(duration // chunk_seconds) + 1
    chunks = []
    chunk_dir = audio_path.parent / f"{audio_path.stem}-chunks"
    chunk_dir.mkdir(exist_ok=True)
    for i in range(n):
        start = i * chunk_seconds
        out = chunk_dir / f"chunk-{i:02d}.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(audio_path),
             "-ss", str(start), "-t", str(chunk_seconds),
             "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k",
             str(out)],
            check=True,
        )
        if out.stat().st_size > 0:
            chunks.append(out)
    return chunks


def transcribe_audio(audio_path: Path, openai_client: OpenAI) -> str:
    size = audio_path.stat().st_size
    print(f"[whisper] Transcribing {audio_path.name} ({size/1_048_576:.1f} MB)...", flush=True)
    start = time.time()

    if size <= WHISPER_SIZE_LIMIT:
        with open(audio_path, "rb") as f:
            result = openai_client.audio.transcriptions.create(
                model="whisper-1", file=f, response_format="text",
            )
        transcript = result if isinstance(result, str) else result.text
    else:
        print(f"[whisper] Over {WHISPER_SIZE_LIMIT/1_048_576:.0f} MB — chunking", flush=True)
        chunks = _chunk_audio(audio_path, CHUNK_SECONDS)
        parts = []
        for i, chunk in enumerate(chunks):
            print(f"[whisper] Chunk {i+1}/{len(chunks)} ({chunk.stat().st_size/1_048_576:.1f} MB)", flush=True)
            with open(chunk, "rb") as f:
                res = openai_client.audio.transcriptions.create(
                    model="whisper-1", file=f, response_format="text",
                )
            parts.append(res if isinstance(res, str) else res.text)
        transcript = "\n\n".join(parts)

    elapsed = int(time.time() - start)
    print(f"[whisper] Done in {elapsed}s, {len(transcript)} chars", flush=True)
    return transcript


def extract_objections(transcript: str, openai_client: OpenAI) -> list[dict]:
    print(f"[extract] Calling gpt-4o for structured extraction...", flush=True)
    start = time.time()

    schema = {
        "type": "object",
        "properties": {
            "objections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "objection": {"type": "string", "description": "One-sentence objection"},
                        "category": {
                            "type": "string",
                            "enum": ["factual", "structural", "stylistic", "adversarial"],
                        },
                        "severity": {"type": "integer", "minimum": 1, "maximum": 5},
                        "quote": {"type": "string", "description": "Quote or paraphrase from transcript"},
                        "target": {"type": "string", "description": "Passage/claim from draft being critiqued"},
                    },
                    "required": ["objection", "category", "severity", "quote", "target"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["objections"],
        "additionalProperties": False,
    }

    resp = openai_client.chat.completions.create(
        model="gpt-4o-2024-08-06",
        messages=[
            {"role": "system", "content": EXTRACTION_SYSTEM},
            {"role": "user", "content": EXTRACTION_USER_TEMPLATE.format(transcript=transcript)},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "objections", "strict": True, "schema": schema},
        },
    )
    elapsed = int(time.time() - start)
    data = json.loads(resp.choices[0].message.content)
    objs = data.get("objections", [])
    print(f"[extract] {len(objs)} objections in {elapsed}s", flush=True)
    return objs


def write_objections_to_memory(
    objections: list[dict],
    db_path: Path,
    draft_path: Path,
    iteration: int,
    nb_id: str,
    audio_path: Path,
) -> list[str]:
    now_ms = int(time.time() * 1000)
    draft_date = datetime.utcnow().strftime("%Y-%m-%d")
    ids = []

    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    for idx, obj in enumerate(objections):
        fact_id = str(uuid.uuid4())
        severity_weight = float(obj.get("severity", 3)) / 5.0
        metadata = {
            "draft_path": str(draft_path),
            "draft_date": draft_date,
            "iteration": iteration,
            "notebook_id": nb_id,
            "audio_path": str(audio_path),
            "category": obj["category"],
            "severity": obj["severity"],
            "host_quote": obj["quote"],
            "target": obj["target"],
        }
        cur.execute(
            """
            INSERT INTO facts (
              id, persona, entity, key, value, text, category, decay_class,
              importance, source, created_at, confidence, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fact_id,
                "shared",
                f"critique.{draft_path.stem}",
                f"{obj['category']}-{idx:02d}",
                obj["objection"],
                obj["objection"],
                "objection",
                "stable",
                severity_weight,
                "notebooklm-critique",
                now_ms,
                0.9,
                json.dumps(metadata),
            ),
        )
        ids.append(fact_id)
    conn.commit()
    conn.close()
    print(f"[memory] Inserted {len(ids)} objections into {db_path}", flush=True)
    return ids


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", required=True, help="Path to draft markdown")
    ap.add_argument("--iteration", type=int, default=1)
    ap.add_argument("--output", default="/home/workspace/Documents/BrainDumps/critiques")
    ap.add_argument("--title-prefix", default="Critique")
    ap.add_argument("--memory-db", default="/home/workspace/.zo/memory/shared-facts.db")
    ap.add_argument("--audio-timeout", type=int, default=900)
    ap.add_argument("--skip-audio", action="store_true", help="Reuse existing audio (for debugging)")
    ap.add_argument("--audio-path", default=None, help="Reuse this audio file instead of generating")
    args = ap.parse_args()

    draft_path = Path(args.draft).resolve()
    if not draft_path.exists():
        print(f"ERROR: draft not found: {draft_path}", file=sys.stderr)
        sys.exit(1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_filename = f"critique-{draft_path.stem}-iter{args.iteration}.mp3"
    audio_path = Path(args.audio_path) if args.audio_path else (output_dir / audio_filename)

    openai_client = OpenAI()

    storage = Path.home() / ".notebooklm" / "storage_state.json"
    if not storage.exists():
        print("ERROR: Not authenticated. Run 'nlm.py import-cookies'.", file=sys.stderr)
        sys.exit(1)

    nb_id = None
    if not args.skip_audio:
        client = await NotebookLMClient.from_storage()
        await client.__aenter__()
        try:
            nb_id = await build_notebook(client, draft_path, args.title_prefix)
            await generate_debate_audio(client, nb_id, audio_path, timeout=args.audio_timeout)
        finally:
            await client.__aexit__(None, None, None)
    else:
        if not audio_path.exists():
            print(f"ERROR: --skip-audio but no audio at {audio_path}", file=sys.stderr)
            sys.exit(1)
        print(f"[audio] Reusing {audio_path}", flush=True)

    transcript = transcribe_audio(audio_path, openai_client)
    transcript_path = output_dir / f"transcript-{draft_path.stem}-iter{args.iteration}.txt"
    transcript_path.write_text(transcript)
    print(f"[whisper] Transcript saved → {transcript_path}", flush=True)

    objections = extract_objections(transcript, openai_client)
    objections_path = output_dir / f"objections-{draft_path.stem}-iter{args.iteration}.json"
    objections_path.write_text(json.dumps(objections, indent=2))
    print(f"[extract] Objections saved → {objections_path}", flush=True)

    ids = write_objections_to_memory(
        objections,
        Path(args.memory_db),
        draft_path,
        args.iteration,
        nb_id or "reused",
        audio_path,
    )

    summary = {
        "draft": str(draft_path),
        "iteration": args.iteration,
        "notebook_id": nb_id,
        "audio": str(audio_path),
        "transcript": str(transcript_path),
        "objections_file": str(objections_path),
        "objection_count": len(objections),
        "memory_ids": ids,
        "by_category": {
            cat: sum(1 for o in objections if o["category"] == cat)
            for cat in ["factual", "structural", "stylistic", "adversarial"]
        },
        "by_severity": {
            str(s): sum(1 for o in objections if o["severity"] == s)
            for s in range(1, 6)
        },
    }
    summary_path = output_dir / f"summary-{draft_path.stem}-iter{args.iteration}.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
