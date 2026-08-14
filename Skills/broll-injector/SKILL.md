---
name: broll-injector
description: >
  Inject cinematic AI-generated b-roll into a talking-head ("spine") video for a
  visually richer presentation. Reads the presenter transcript (SRT or plain text),
  picks N cutaway moments, generates one silent clip per moment via the fal-ai-media
  skill (veo3.1-fast text-to-video, or nano-banana-2 stills turned into Ken Burns
  clips), and intercuts them over the spine with a deterministic, proven ffmpeg
  formula — full-frame cutaway or picture-in-picture. Use when the user wants to turn
  a HeyGen/Mimir/Alaric talking head into a graphics-rich cut, "add b-roll", or "make
  this video less of a static talking head". Resumable, fail-loud, file-based DAG:
  plan -> generate -> compose. A --dry-run path proves the whole pipeline with ZERO
  fal.ai spend by fabricating labeled placeholder clips.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# B-Roll Injector

Turns a talking-head "spine" video into a visually rich cut with AI b-roll intercut
over it. One conductor (`scripts/inject.ts`) runs a 3-stage DAG; every stage is
file-based and skips when its artifact already exists, so runs are resumable and
`--force` re-runs from any point.

```
plan       SRT/transcript -> <run>/00-plan.json     (extract-plan.ts via /zo/ask)
generate   00-plan.json   -> <run>/broll/<id>.mp4   (gen-broll.ts via fal-ai-media)
compose    spine + clips  -> <name>-broll.mp4       (compose.py, proven ffmpeg)
```

## Quick start

```bash
# Full auto: transcript in, b-roll cut out
bun /home/workspace/Skills/broll-injector/scripts/inject.ts \
  --base SPINE.mp4 --srt CAPTIONS.srt

# Prove the whole pipeline with ZERO fal.ai spend (placeholder b-roll)
bun .../inject.ts --base SPINE.mp4 --srt CAPTIONS.srt --dry-run

# Skip auto-planning, hand-author the moments yourself
bun .../inject.ts --base SPINE.mp4 --plan my-plan.json
```

The output lands at `<run-dir>/<name>-broll.mp4` and the run dir defaults to
`<dir-of-base>/broll-<name>/`.

## Why it exists

A static talking head is visually flat. This skill keeps the presenter's audio as the
backbone and cuts away to concrete, cinematic b-roll at the strongest moments —
without a human editor, and without a new credit surface (it routes through the
existing `fal-ai-media` skill on the user's own `FAL_KEY`).

## Stages

### 1. plan — `scripts/extract-plan.ts`
Parses a word/line-level SRT (HeyGen caption output) or a plain transcript, then asks
this same Zo (headless, via `/zo/ask`) to choose N b-roll moments: where to cut away,
what to show, and a cinematic prompt for each. Emits:

```json
{ "base_video": "...", "fps": 25,
  "moments": [ {"id","start","hold","source","mode","model","prompt","trigger_phrase"} ] }
```

You can skip this stage entirely by passing `--plan my-plan.json` (hand-authored).

### 2. generate — `scripts/gen-broll.ts`
One silent clip per moment, normalized to a clean 25fps yuv420p mp4 so the compositor
only ever deals with concat-compatible video:

- `source: "t2v"`  → `fal-media.ts t2v` (veo3.1-fast, `--no-audio`) → normalize
- `source: "still"` → `fal-media.ts generate` (nano-banana-2) → Ken Burns zoompan

Per-clip caching: a moment whose `<id>.mp4` already exists is skipped unless `--force`.

### 3. compose — `scripts/compose.py`
Deterministic ffmpeg compositor. For each moment it time-shifts the clip
(`setpts=PTS+start/TB`) and gates a single overlay onto the spine
(`overlay=...:enable='between(t,start,end)'`) — proven on the Zouroboros Academy
renders. Audio is always copied straight from the spine. Per-moment `hold` is clamped
to the generated clip's real duration, which kills the frozen/dark tail. `--crossfade`
swaps the hard cut for alpha fades (opt-in; hard cut is the proven default).

## Modes

| mode | effect |
|------|--------|
| `fullframe` | b-roll covers the whole frame (cover + center-crop). The cutaway. |
| `pip` | b-roll as a corner picture-in-picture over the presenter. |

`--mode` sets the global default; a per-moment `mode` in the plan overrides it.

## Key options (`inject.ts`)

| flag | default | meaning |
|------|---------|---------|
| `--base` | (required) | the talking-head spine mp4 |
| `--srt` / `--transcript` / `--plan` | — | one source of moments (plan skips extraction) |
| `--out` | `<run>/<name>-broll.mp4` | final output |
| `--run-dir` | `<dir>/broll-<name>` | resumable artifact dir |
| `--count` | 5 | how many moments to auto-pick |
| `--mode` | fullframe | global cutaway mode |
| `--source` | t2v | t2v (motion) or still (Ken Burns) |
| `--model` | veo3.1-fast / nano-banana-2 | fal model |
| `--crossfade` | off | alpha fades instead of hard cuts |
| `--pip-scale` / `--margin` | 0.42 / 40 | PiP size + corner inset |
| `--dry-run` | off | placeholder b-roll, zero fal spend |
| `--force` | off | re-run every stage |

## Cost discipline

`--dry-run` fabricates a labeled colour-card clip per moment so the full DAG can be
validated end-to-end before paying fal. Always dry-run a new plan first, eyeball the
windows/modes, then drop `--dry-run` for the real render. A real run spends one
fal.ai generation per moment (veo3.1-fast t2v or a nano-banana-2 still).

See `references/pipeline.md` for the design, the ffmpeg formula, and the gotchas.
