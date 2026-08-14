#!/usr/bin/env python3
"""Fallback podcast generator using Gemini API + ElevenLabs/gTTS.

Durable alternative to NotebookLM audio overviews. Generates two-person
podcast-style audio from markdown source files.

Usage:
    python podcast-gen.py --source guide.md --output podcast.mp3
    python podcast-gen.py --source guide.md --output podcast.mp3 --length 10
    python podcast-gen.py --batch-dir ./modules/ --output-dir ./podcasts/

Requires:
    GEMINI_API_KEY in environment (Zo secrets)
    Optional: ELEVENLABS_API_KEY for premium voices
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from google import genai
    HAS_GEMINI = True
except ImportError:
    HAS_GEMINI = False

try:
    from elevenlabs import ElevenLabs
    HAS_ELEVENLABS = True
except ImportError:
    HAS_ELEVENLABS = False


SCRIPT_PROMPT = """You are a podcast script writer. Given the following educational content,
write a natural two-person podcast script between a HOST and a GUEST (expert).

Rules:
- HOST is curious, asks good questions, summarizes for the audience
- GUEST is the subject matter expert, explains concepts clearly
- Keep it conversational and engaging, not lecture-style
- Include natural transitions, reactions ("That's fascinating", "Right, so...")
- Target approximately {length} minutes of spoken content (~150 words per minute)
- Format each line as: HOST: <text> or GUEST: <text>
- Start with a brief intro, end with a takeaway summary

Content to cover:
---
{content}
---

Write the podcast script now:"""


def generate_script(content: str, length: int = 10) -> list[dict]:
    """Generate podcast script using Gemini API."""
    if not HAS_GEMINI:
        print("ERROR: google-generativeai not installed. Run: pip install google-generativeai", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("ERROR: GEMINI_API_KEY not set. Add it in Zo Settings > Advanced > Secrets.", file=sys.stderr)
        sys.exit(1)

    client = genai.Client(api_key=api_key)

    prompt = SCRIPT_PROMPT.format(content=content, length=length)
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=prompt,
    )

    lines = []
    for line in response.text.strip().split("\n"):
        line = line.strip()
        if line.startswith("HOST:"):
            lines.append({"speaker": "host", "text": line[5:].strip()})
        elif line.startswith("GUEST:"):
            lines.append({"speaker": "guest", "text": line[6:].strip()})

    return lines


def synthesize_elevenlabs(script: list[dict], output: str, host_voice: str = "Rachel", guest_voice: str = "Adam"):
    """Synthesize audio using ElevenLabs API."""
    if not HAS_ELEVENLABS:
        print("ERROR: elevenlabs not installed. Run: pip install elevenlabs", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY not set.", file=sys.stderr)
        sys.exit(1)

    client = ElevenLabs(api_key=api_key)

    segments = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, line in enumerate(script):
            voice = host_voice if line["speaker"] == "host" else guest_voice
            audio = client.text_to_speech.convert(
                text=line["text"],
                voice_id=voice,
                model_id="eleven_multilingual_v2",
            )
            seg_path = os.path.join(tmpdir, f"seg_{i:04d}.mp3")
            with open(seg_path, "wb") as f:
                for chunk in audio:
                    f.write(chunk)
            segments.append(seg_path)
            sys.stdout.write(f"\r  Synthesized {i+1}/{len(script)} segments")
            sys.stdout.flush()

        print()

        list_file = os.path.join(tmpdir, "segments.txt")
        with open(list_file, "w") as f:
            for seg in segments:
                f.write(f"file '{seg}'\n")

        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", output],
            capture_output=True, check=True,
        )

    print(f"  Saved: {output}")


def synthesize_gtts(script: list[dict], output: str):
    """Synthesize audio using Google TTS (free, lower quality)."""
    try:
        from gtts import gTTS
    except ImportError:
        print("ERROR: gTTS not installed. Run: pip install gTTS", file=sys.stderr)
        sys.exit(1)

    segments = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, line in enumerate(script):
            tts = gTTS(text=line["text"], lang="en")
            seg_path = os.path.join(tmpdir, f"seg_{i:04d}.mp3")
            tts.save(seg_path)
            segments.append(seg_path)
            sys.stdout.write(f"\r  Synthesized {i+1}/{len(script)} segments")
            sys.stdout.flush()

        print()

        list_file = os.path.join(tmpdir, "segments.txt")
        with open(list_file, "w") as f:
            for seg in segments:
                f.write(f"file '{seg}'\n")

        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", output],
            capture_output=True, check=True,
        )

    print(f"  Saved: {output}")


def process_source(source_path: str, output_path: str, length: int = 10,
                   host_voice: str = "Rachel", guest_voice: str = "Adam"):
    """Full pipeline: source → script → audio."""
    content = Path(source_path).read_text()
    print(f"Generating script from: {source_path}")

    script = generate_script(content, length)
    print(f"  Generated {len(script)} dialogue lines")

    script_out = Path(output_path).with_suffix(".script.json")
    script_out.write_text(json.dumps(script, indent=2))
    print(f"  Script saved: {script_out}")

    print(f"Synthesizing audio...")
    if os.environ.get("ELEVENLABS_API_KEY"):
        synthesize_elevenlabs(script, output_path, host_voice, guest_voice)
    else:
        print("  (Using gTTS — set ELEVENLABS_API_KEY for premium voices)")
        synthesize_gtts(script, output_path)


def main():
    parser = argparse.ArgumentParser(description="Podcast generator (Gemini + TTS)")
    parser.add_argument("--source", help="Source markdown file")
    parser.add_argument("--output", help="Output MP3 path")
    parser.add_argument("--length", type=int, default=10, help="Target length in minutes")
    parser.add_argument("--host-voice", default="Rachel", help="ElevenLabs host voice")
    parser.add_argument("--guest-voice", default="Adam", help="ElevenLabs guest voice")
    parser.add_argument("--batch-dir", help="Directory of markdown files to batch process")
    parser.add_argument("--output-dir", help="Output directory for batch mode")
    parser.add_argument("--script-only", action="store_true", help="Only generate scripts, no audio")

    args = parser.parse_args()

    if args.batch_dir:
        batch_dir = Path(args.batch_dir)
        output_dir = Path(args.output_dir or "./podcasts")
        output_dir.mkdir(parents=True, exist_ok=True)

        sources = sorted(batch_dir.glob("*.md"))
        print(f"Batch processing {len(sources)} files...\n")

        for src in sources:
            out = output_dir / src.with_suffix(".mp3").name
            try:
                if args.script_only:
                    content = src.read_text()
                    script = generate_script(content, args.length)
                    script_out = output_dir / src.with_suffix(".script.json").name
                    script_out.write_text(json.dumps(script, indent=2))
                    print(f"Script: {script_out}")
                else:
                    process_source(str(src), str(out), args.length, args.host_voice, args.guest_voice)
            except Exception as e:
                print(f"ERROR processing {src.name}: {e}", file=sys.stderr)
            print()

    elif args.source:
        output = args.output or Path(args.source).with_suffix(".mp3").name
        if args.script_only:
            content = Path(args.source).read_text()
            script = generate_script(content, args.length)
            script_out = Path(output).with_suffix(".script.json")
            script_out.write_text(json.dumps(script, indent=2))
            print(f"Script saved: {script_out}")
        else:
            process_source(args.source, output, args.length, args.host_voice, args.guest_voice)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
