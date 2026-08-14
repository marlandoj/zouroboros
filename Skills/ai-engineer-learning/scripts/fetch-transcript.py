#!/usr/bin/env python3
import argparse
import json
import sys

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    IpBlocked,
    NoTranscriptFound,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
)


def emit(status, **fields):
    print(json.dumps({"status": status, **fields}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="Fetch one YouTube transcript with structured diagnostics.")
    parser.add_argument("video_id")
    args = parser.parse_args()

    try:
        entries = YouTubeTranscriptApi().fetch(
            args.video_id,
            languages=["en", "en-US", "en-GB"],
        )
        text = " ".join(entry.text.replace("\n", " ").strip() for entry in entries if entry.text)
        if len(text) < 100:
            emit("unavailable", errorType="EmptyTranscript", error="Transcript contained insufficient text")
            return 3
        emit("ok", text=text)
        return 0
    except (NoTranscriptFound, TranscriptsDisabled) as exc:
        emit("unavailable", errorType=type(exc).__name__, error=str(exc)[:2000])
        return 3
    except (IpBlocked, RequestBlocked, VideoUnavailable, VideoUnplayable) as exc:
        emit("provider_blocked", errorType=type(exc).__name__, error=str(exc)[:2000])
        return 4
    except Exception as exc:
        emit("error", errorType=type(exc).__name__, error=str(exc)[:2000])
        return 5


if __name__ == "__main__":
    sys.exit(main())
