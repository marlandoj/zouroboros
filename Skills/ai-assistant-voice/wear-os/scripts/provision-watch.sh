#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 WATCH_HOST:WATCH_PORT [BASE_URL]" >&2
  echo "Reads the signing secret from stdin or ALARIC_VOICE_SECRET; never passes it as an argument." >&2
  exit 1
fi

TARGET="$1"
BASE_URL="${2:-https://marlandoj.zo.space}"

SECRET="${ALARIC_VOICE_SECRET:-}"
if [ -z "$SECRET" ]; then
  read -r -s -p "Signing secret: " SECRET
  echo
fi
if [ "${#SECRET}" -lt 32 ]; then
  echo "secret must be at least 32 characters" >&2
  exit 1
fi

adb connect "$TARGET" >/dev/null
RESULT=$(adb -s "$TARGET" shell am broadcast \
  -n computer.zo.alaric.voice/.ProvisionReceiver \
  -a computer.zo.alaric.voice.PROVISION \
  --es base_url "$BASE_URL" \
  --es signing_secret "$SECRET")

echo "$RESULT"
case "$RESULT" in
  *"result=1"*) echo "Provisioned $TARGET for $BASE_URL" ;;
  *) echo "Provisioning failed (receiver is debug-build only; is the debug APK installed?)" >&2; exit 1 ;;
esac
