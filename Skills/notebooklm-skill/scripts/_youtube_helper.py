"""YouTube search + channel listing via yt-dlp.

Replaces Artem's InnerTube traversal with yt-dlp's battle-tested implementation.
Zero auth required for public videos/channels. Returns lightweight metadata
suitable for NotebookLM ingestion (id, url, title, channel, duration, thumbnail).
"""
import json
import shutil
import subprocess
from typing import Iterator


def _check_ytdlp() -> str:
    path = shutil.which("yt-dlp")
    if not path:
        raise RuntimeError("yt-dlp not installed. Install: pip install yt-dlp")
    return path


def _run(args: list[str]) -> Iterator[dict]:
    cmd = [_check_ytdlp(), "--flat-playlist", "--dump-json", "--no-warnings", "--quiet", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0 and not proc.stdout:
        raise RuntimeError(f"yt-dlp failed (exit {proc.returncode}): {proc.stderr.strip()[:300]}")
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def _normalize(entry: dict) -> dict:
    vid = entry.get("id") or ""
    url = entry.get("url") or (f"https://www.youtube.com/watch?v={vid}" if vid else "")
    duration_s = entry.get("duration")
    return {
        "id": vid,
        "url": url,
        "title": entry.get("title", "").strip(),
        "channel": entry.get("channel") or entry.get("uploader") or "",
        "channel_url": entry.get("channel_url") or entry.get("uploader_url") or "",
        "duration_s": int(duration_s) if duration_s else None,
        "view_count": entry.get("view_count"),
        "thumbnail": entry.get("thumbnail")
            or (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else None),
        "upload_date": entry.get("upload_date"),
    }


def search_videos(query: str, limit: int = 10) -> list[dict]:
    """Search YouTube. Returns up to `limit` normalized video dicts."""
    if limit < 1:
        return []
    target = f"ytsearch{limit}:{query}"
    return [_normalize(e) for e in _run([target]) if e.get("id")][:limit]


def fetch_transcript(video_id_or_url: str) -> str | None:
    """Fetch transcript text for a video. Returns None if unavailable.

    Tries manual subtitles, then auto-generated captions. English-only.
    """
    vid = video_id_or_url
    if "youtube.com" in vid or "youtu.be" in vid:
        if "v=" in vid:
            vid = vid.split("v=", 1)[1].split("&", 1)[0]
        else:
            vid = vid.rstrip("/").rsplit("/", 1)[-1]
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled, NoTranscriptFound, VideoUnavailable,
        )
    except ImportError:
        return None
    try:
        api = YouTubeTranscriptApi()
        try:
            fetched = api.fetch(vid, languages=["en", "en-US", "en-GB"])
        except (NoTranscriptFound, TranscriptsDisabled):
            return None
        return " ".join(seg.text for seg in fetched if seg.text).strip() or None
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable):
        return None
    except Exception:
        return None


def channel_videos(channel_url: str, limit: int = 250) -> list[dict]:
    """List videos from a channel URL. Accepts /@handle, /channel/UC..., or /c/Name.

    Appends /videos if not already present so we don't hit Shorts/Live tabs.
    """
    url = channel_url.rstrip("/")
    if not url.endswith("/videos") and "/playlist?" not in url and "/watch?" not in url:
        url = f"{url}/videos"
    args = ["--playlist-end", str(limit), url]
    return [_normalize(e) for e in _run(args) if e.get("id")][:limit]


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="YouTube search/channel helper (yt-dlp wrapper)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("-n", "--limit", type=int, default=10)
    c = sub.add_parser("channel")
    c.add_argument("url")
    c.add_argument("-n", "--limit", type=int, default=250)
    args = ap.parse_args()
    results = search_videos(args.query, args.limit) if args.cmd == "search" \
        else channel_videos(args.url, args.limit)
    print(json.dumps(results, indent=2))
