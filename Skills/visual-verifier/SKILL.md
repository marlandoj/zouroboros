---
name: visual-verifier
description: >-
  Rendered-output verification station for the swarm post-flight eval. After a
  maker subagent produces a visual deliverable (UI/route/site), the station
  captures a full-page screenshot via agent-browser, then an independent
  verifier model (not equal to author, per aiewf P0-2) reads the screenshot
  against seed acceptance criteria + project DESIGN.md tokens + prior
  screenshots. Match marks the task complete; mismatch emits a structured
  visual diff for the maker's next iteration. The verifier is the exit
  condition, not the maker. Recurring visual failure modes graduate to
  instincts.yaml via the extract-patterns gate (ZOU-452).
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  linear: ZOU-493
  aiewf: SIL-13
  depends_on: consensus-gate (reviewer-independence.ts), agent-browser, extract-patterns
---

# Visual Self-Verification Station

## When to use

The swarm post-flight eval (Stage 2) invokes this station when a seed task is
flagged `visual: true`. The station runs AFTER text-based acceptance criteria
pass — it is a second-order check that catches rendered-output failures text
eval structurally misses (wrong palette, broken layout, hydration flash,
overlapping elements, default Tailwind tokens instead of project DESIGN.md).

## Architecture (confirmed defaults)

- **Multimodal read OUTSIDE the gate** (q1=A): the station's verifier script
  sends the screenshot to a vision-capable model and gets a text verdict +
  structured diff. The consensus-gate is NOT modified — only the
  `reviewer-independence.ts` helper library is reused for the ≠author
  constraint.
- **Single verifier** (q2): one multimodal model reads the screenshot. A
  multi-verifier panel is available behind `VISUAL_VERIFIER_PANEL=1` for
  future activation but defaults off.

## Scripts

### `scripts/capture.ts`
Captures a full-page screenshot of a URL via agent-browser.

```bash
bun scripts/capture.ts --url "http://localhost:3099/my-route" --output /tmp/screenshot.png
```

### `scripts/verify.ts`
Independent verifier — reads the screenshot image, compares against
references, returns a structured verdict.

```bash
bun scripts/verify.ts \
  --screenshot /tmp/screenshot.png \
  --criteria "The page uses the project's amethyst+gold palette, not default zinc" \
  --design-md /home/workspace/Projects/my-project/01-brand/DESIGN.md \
  --author "hf:zai-org/GLM-5.2" \
  --label "my-route"
```

### `scripts/station.ts`
Full pipeline: capture → verify → emit verdict. Used by the post-flight harness.

```bash
bun scripts/station.ts \
  --url "http://localhost:3099/my-route" \
  --criteria "..." \
  --design-md "..." \
  --author "..." \
  --label "..." \
  --project-dir "..."
```

## Config flags

| Flag | Default | Effect |
|------|---------|--------|
| `VISUAL_VERIFIER` | ON (1) | Master switch; `0` skips the station entirely |
| `VISUAL_VERIFIER_MODEL` | `gpt-4o` | Multimodal model for the screenshot read |
| `VISUAL_VERIFIER_PANEL` | OFF (0) | If ON, runs a multi-verifier panel via consensus-gate helpers |
| `VISUAL_VERIFIER_HYDRATE_MS` | 3000 | Sleep after `agent-browser open` before screenshot |
| `VISUAL_VERIFIER_CONF_THRESHOLD` | 0.7 | Minimum verifier confidence to act on a mismatch |

## Compounding

Every mismatch is logged to `Projects/<project>/visual-failures.jsonl`. The
existing `extract-patterns` gate (ZOU-452) reads this log on its scheduled run
and applies the 4-criteria test; a pattern with >=2 confirmed occurrences
graduates to `instincts.yaml`. The station does NOT write instincts directly
— it feeds the gate.

## Rollback

`VISUAL_VERIFIER=0` disables the station. Non-visual deliverables are
byte-identical to today (the `visual` flag is absent by default). Full revert:
remove the Stage 2 plug-in call, delete this skill, remove the `visual` flag
from the seed schema.
