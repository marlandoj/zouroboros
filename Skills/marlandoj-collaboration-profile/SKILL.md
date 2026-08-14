---
name: marlandoj-collaboration-profile
description: Quarterly drift watcher for marlandoj's collaboration style baseline. Scans typed user messages from zo_conversations.duckdb and staging payloads, diffs against a frozen baseline (median chars, frustration rate, cadence), and exits 0/1/2 for no-drift/drift/error. Identity files are never auto-modified — drift requires human review.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  baseline_frozen: "2026-05-02"
  scan_cadence: quarterly (90 days)
---

# Collaboration Profile Drift Guard

Monitors marlandoj's typing patterns against a frozen baseline to surface meaningful shifts in collaboration style.

## Files

| File | Purpose |
|------|---------|
| `baseline.json` | Frozen metrics (n, median_chars, frustration_rate, thresholds) |
| `scripts/rescan_and_diff.py` | Scanner + differ — the main script |
| `last-diff.md` | Output of last drift run (written on exit 1 only) |

## Profile source of truth

`/home/workspace/Notes/marlandoj-collaboration-profile.md` — human-authored; never auto-modified.

## Running manually

```bash
# Quarterly drift check (dry run)
python3 /home/workspace/Skills/marlandoj-collaboration-profile/scripts/rescan_and_diff.py

# Refresh baseline after reviewing drift
python3 /home/workspace/Skills/marlandoj-collaboration-profile/scripts/rescan_and_diff.py --update-baseline

# Custom window
python3 /home/workspace/Skills/marlandoj-collaboration-profile/scripts/rescan_and_diff.py --window-days 30
```

## Exit codes

| Code | Meaning | Agent action |
|------|---------|-------------|
| 0 | No drift | Silent — do not email |
| 1 | Drift detected | Email HTML+PDF report; `last-diff.md` is the source |
| 2 | Error (missing baseline, unreadable archive) | Send SMS error notice |

## Baseline parameters (2026-05-02 freeze)

- **n:** 5,956 typed messages (Dec 2025 – Apr 2026)
- **median:** 72 chars
- **frustration_rate:** 0.0 (zero instances)
- **Monthly trajectory:** 142c (Dec) → 65c (Apr) — terse maturation arc

## SOUL constraint

Per SOUL.md "never auto-write to identity files" — this skill only reads and reports. The human decides whether to call `--update-baseline`.
