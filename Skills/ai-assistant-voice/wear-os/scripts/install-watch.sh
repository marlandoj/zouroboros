#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 WATCH_HOST:WATCH_PORT [apk]" >&2
  exit 1
fi

TARGET="$1"
APK="${2:-$(dirname "$0")/../artifacts/alaric-voice-wear-debug.apk}"

if [ ! -f "$APK" ]; then
  echo "APK not found: $APK (run ./gradlew assembleDebug first)" >&2
  exit 1
fi

adb connect "$TARGET"
adb -s "$TARGET" install -r "$APK"
echo "Installed $(basename "$APK") on $TARGET"
