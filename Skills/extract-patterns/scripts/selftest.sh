#!/usr/bin/env bash
# Selftest for extract-patterns-hook.sh (ZOU-452). Uses a fake session id and
# a temp transcript; cleans its own sentinels/log lines. Exit 0 = all pass.
set -u
HOOK="$(dirname "$0")/extract-patterns-hook.sh"
SID="selftest-$$"
LOG="/dev/shm/extract-patterns.log"
SDIR="/dev/shm/extract-patterns"
T=$(mktemp)
PASS=0; FAIL=0
ck() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1 (got: $2 | want: $3)"; fi; }

payload() { printf '{"hook_event_name":"%s","session_id":"%s","stop_hook_active":%s,"transcript_path":"%s"}' "$1" "$SID" "$2" "$T"; }

# 1. sub-threshold Stop → silent exit, no sentinel
printf 'line\n' > "$T"
OUT=$(payload Stop false | bash "$HOOK")
ck "sub-threshold silent" "$OUT" ""
ck "sub-threshold no sentinel" "$(ls "$SDIR/$SID.prompted" 2>/dev/null)" ""

# 2. threshold crossed → block JSON + sentinel + log line
for i in $(seq 1 50); do echo "line $i"; done > "$T"
OUT=$(payload Stop false | bash "$HOOK")
ck "prompt emits block" "$(printf '%s' "$OUT" | jq -r .decision 2>/dev/null)" "block"
ck "prompt writes sentinel" "$([[ -f "$SDIR/$SID.prompted" ]] && echo yes)" "yes"
ck "prompt logged" "$(grep -c "session=$SID decision=prompted" "$LOG" 2>/dev/null)" "1"

# 3. second Stop same session → silent (once per session)
OUT=$(payload Stop false | bash "$HOOK")
ck "prompt-once" "$OUT" ""

# 4. stop_hook_active=true → silent (loop guard) even for fresh session
SID2="${SID}-b"
OUT=$(printf '{"hook_event_name":"Stop","session_id":"%s","stop_hook_active":true,"transcript_path":"%s"}' "$SID2" "$T" | bash "$HOOK")
ck "loop guard" "$OUT" ""

# 5. SessionEnd with prompted-but-unresolved → back-fill line
payload SessionEnd false | bash "$HOOK" > /dev/null
ck "sessionend unresolved" "$(grep -c "session=$SID decision=prompted-unresolved" "$LOG")" "1"

# 6. SessionEnd for never-reviewed session → below-threshold line, never blocks
OUT=$(printf '{"hook_event_name":"SessionEnd","session_id":"%s","stop_hook_active":false,"transcript_path":"%s"}' "$SID2" "$T" | bash "$HOOK")
ck "sessionend no block" "$OUT" ""
ck "sessionend below-threshold" "$(grep -c "session=$SID2 decision=no-review" "$LOG")" "1"

# 7. SessionEnd after an agent-logged decision → no extra line
echo "$(date -u +%FT%TZ) session=$SID decision=none" >> "$LOG"
payload SessionEnd false | bash "$HOOK" > /dev/null
ck "sessionend respects resolved" "$(grep -c "session=$SID decision=prompted-unresolved" "$LOG")" "1"

# 8. kill switch
SID3="${SID}-c"
OUT=$(printf '{"hook_event_name":"Stop","session_id":"%s","stop_hook_active":false,"transcript_path":"%s"}' "$SID3" "$T" | EXTRACT_PATTERNS_OFF=1 bash "$HOOK")
ck "kill switch" "$OUT" ""

# 9. malformed stdin → fail open, no output
OUT=$(printf 'not json' | bash "$HOOK")
ck "fail open" "$OUT" ""

# cleanup
rm -f "$T" "$SDIR/$SID.prompted" "$SDIR/$SID2.prompted" 2>/dev/null
sed -i "/session=$SID/d" "$LOG" 2>/dev/null

echo "extract-patterns selftest: $PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]]
