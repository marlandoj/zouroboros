#!/bin/bash
# Guard (2026-07-03; hardened 2026-07-06): block pushes that would re-introduce purged client content.
# History was rewritten to remove client references; local-only branches still carry pre-purge history.
# Scans commit messages, file PATHS, and diff CONTENT. Emits a non-blocking ancestry WARNING too.
# NOTE: kept LOCAL/untracked on purpose — the client-name patterns must never be published to the public remote.
z40=0000000000000000000000000000000000000000
PATTERN='\bjhf|aventurine|jackson[ _-]?heritage|fauna[ _-]?flora|\bffb\b'
blocked=0
remote_name="${1:-origin}"
remote_url="${2:-}"

# 0) DESTINATION ALLOWLIST (added 2026-08-05). Content scanning is necessary but
# not sufficient: it only knows 5 client-name patterns and cannot see JNJ material,
# secrets, or client data under any other name. This repo is /home/workspace — the
# workspace itself — and its ONLY legitimate remote is marlandoj/zouroboros (zbr).
# `origin` here is marlandoj/hermes-agent, a PUBLIC repo with a history unrelated
# to this tree; 81 branches (including main) were tracking it before this guard.
# Push to origin is also disabled at the URL level; this is defense in depth.
case "$remote_url" in
  *marlandoj/zouroboros*|"") ;;
  *)
    echo "pre-push guard: BLOCKED — /home/workspace may only push to marlandoj/zouroboros (zbr)." >&2
    echo "  Refused destination: $remote_name -> $remote_url" >&2
    echo "  This tree holds client and confidential material; the client-string scan below" >&2
    echo "  covers only 5 name patterns and is not a sufficient gate for a new destination." >&2
    exit 1
    ;;
esac

remote_main="${remote_name}/main"
if ! git rev-parse -q --verify "$remote_main" >/dev/null 2>&1; then
  remote_main="origin/main"
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$z40" ] && continue

  # Pick a base to scan only the NEW objects being pushed.
  if [ "$remote_sha" != "$z40" ]; then
    base="$remote_sha"
  elif git rev-parse -q --verify "$remote_main" >/dev/null 2>&1; then
    base="$remote_main"
  else
    base=""
  fi

  if [ -n "$base" ]; then
    log_range="$base..$local_sha"
    diff_range="$base...$local_sha"
  else
    log_range="$local_sha"
    diff_range=""
  fi

  # 1) commit messages
  if git log --format='%s%n%b' "$log_range" 2>/dev/null | grep -qiE "$PATTERN"; then
    echo "pre-push guard: BLOCKED — $local_ref: client string in a commit message." >&2
    blocked=1
  fi

  # 1b) file PATHS, excluding deletions (2026-08-05). Removing an offending path is
  # the remediation, not a violation — --diff-filter=d drops deletes so a purge
  # commit can ship. Adds/renames/modifies are still scanned.
  if [ -n "$diff_range" ]; then
    paths="$(git diff --diff-filter=d --name-only "$diff_range" 2>/dev/null)"
  else
    paths="$(git log --diff-filter=d --format= --name-only "$local_sha" 2>/dev/null)"
  fi
  if printf '%s' "$paths" | grep -qiE "$PATTERN"; then
    echo "pre-push guard: BLOCKED — $local_ref: client string in an added/modified file path." >&2
    blocked=1
  fi

  # 2) diff CONTENT — ADDED lines only (2026-08-05). Scanning the whole diff blocked
  # the purge commit itself, because every removed `-project.<client>` line matched.
  # Only content being introduced can leak; removals are the fix.
  if [ -n "$diff_range" ]; then
    content="$(git diff "$diff_range" 2>/dev/null | grep '^+' | grep -v '^+++')"
  else
    content="$(git log -p --format= "$local_sha" 2>/dev/null | grep '^+' | grep -v '^+++')"
  fi
  if printf '%s' "$content" | grep -qiE "$PATTERN"; then
    echo "pre-push guard: BLOCKED — $local_ref: client string in added diff content." >&2
    blocked=1
  fi

  # 3) non-blocking ancestry check (no network fetch — uses the target remote's main ref)
  if git rev-parse -q --verify "$remote_main" >/dev/null 2>&1; then
    if ! git merge-base --is-ancestor "$remote_main" "$local_sha" 2>/dev/null; then
      echo "pre-push guard: WARNING — $local_ref is not a descendant of $remote_main; it may carry pre-purge history." >&2
      echo "  Consider: git rebase --onto $remote_main <old-base> <branch>  so only the deliverable commit ships." >&2
    fi
  fi
done

# 4) non-blocking REMOTE-TREE audit (added 2026-07-27).
# The scans above are range-scoped (base..local_sha), so content ALREADY on
# origin/main never appears in a push diff and passes silently forever.
# A quiet guard is not evidence the remote is clean. -I skips binaries, whose
# hex bytes false-positive on short aliases.
if git rev-parse -q --verify "$remote_main" >/dev/null 2>&1; then
  # -i added 2026-08-05: the blocking scans above are case-insensitive but this audit
  # was not, so FFB / JHF / Aventurine — the actual capitalisations in the tree — were
  # invisible to it. It under-reported 40 files as 32.
  remote_files="$(git grep -IliE "$PATTERN" "$remote_main" -- 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${remote_files:-0}" -gt 0 ]; then
    echo "pre-push guard: WARNING — $remote_main's tree still carries $remote_files file(s) matching the pattern." >&2
    echo "  Range-scoped scans cannot see already-published content. Audit the remote directly:" >&2
    echo "    git grep -IlE \"\$PATTERN\" $remote_main" >&2
  fi
fi

if [ "$blocked" = 1 ]; then
  echo "If this is genuinely intentional, bypass with: git push --no-verify (NOT recommended for the public remote)." >&2
  exit 1
fi
exit 0
