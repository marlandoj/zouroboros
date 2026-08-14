---
name: academy-video-pipeline
description: Programmatic HTML→video generation for the Zouroboros Academy and Alaric/Mimir explainer content, backed by HeyGen HyperFrames. Author a composition as a single HTML file (GSAP/anime.js timelines, captions, voiceovers, audio-reactive visuals) and render it to a real MP4/WebM/MOV/GIF locally with headless Chrome + ffmpeg — no manual ffmpeg zoompan pipeline, no cloud render. Use this to build title cards, faceless explainers, slideshows, product/launch videos, motion graphics, and captioned clips. The heavy multi-step orchestration skills (faceless-explainer, slideshow, etc.) live in Integrations/hyperframes/skills/.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
allowed-tools: Bash, Read, Write, Edit
---

# Academy Video Pipeline (HyperFrames)

Replaces the hand-rolled ffmpeg-zoompan + ElevenLabs stills pipeline for
Academy / Alaric / Mimir explainer content. You write **HTML**, HyperFrames
renders **video**. Apache-2.0, runs fully local.

## Validated environment (2026-06-24)

Confirmed working on this Zo host with **no Docker**:

- Node + `npx hyperframes@latest` (pinned via npx, no global install needed)
- Headless Chrome auto-detected (chrome-headless-shell); `ffmpeg`/`ffprobe` present
- A 3s 1080p30 composition renders in ~10s wall at `-q draft`, 3 workers
- `doctor` reports Docker + whisper-cpp ✗ — **not needed** for local render
  (whisper-cpp only powers `transcribe`; TTS uses Kokoro-82M)

Always export `PUPPETEER_SKIP_DOWNLOAD=1` so npx doesn't try to fetch its own
Chromium (the host's is used instead).

## Quick render (the validated path)

```bash
export PUPPETEER_SKIP_DOWNLOAD=1

# 1. Scaffold a project (blank starter; --skip-skills keeps it lean)
npx -y hyperframes@latest init my-video --non-interactive --example blank --skip-skills

# 2. Author the composition by editing my-video/index.html
#    - #root carries data-duration / data-width / data-height (1920x1080)
#    - each .clip is positioned; window.__timelines["main"] drives GSAP
#    - gsap is loaded from CDN in the scaffolded <head>

# 3. Validate, then render
cd my-video
npx -y hyperframes@latest lint
npx -y hyperframes@latest render -q draft -o renders/test.mp4   # draft | standard | high
```

Output is a real H.264 MP4 (verify with `ffprobe`). Other formats:
`--format webm|mov|gif|png-sequence`. Tune with `-f/--fps`, `-w/--workers`,
`-q/--quality`.

## When to use which orchestration skill

For anything beyond a single title card, drive one of the vendor multi-step
skills in `Integrations/hyperframes/skills/` (they cross-reference each other
with relative paths, so run them from there). The Academy/Mimir fit:

- **faceless-explainer** — text → narrated faceless explainer (30-90s sweet
  spot, every visual invented). **Primary Academy/Mimir skill.** SkillSpector
  pre-adoption scan: score **17 / LOW / SAFE**.
- **slideshow** — deck-style sequences. SkillSpector: **5 / LOW / SAFE**.
- Also shipped: general-video, embedded-captions, graphic-overlays,
  motion-graphics, music-to-video, product-launch-video, website-to-video,
  pr-to-video, hyperframes-animation/creative/media/cli.

If the route is unclear, read `Integrations/hyperframes/skills/hyperframes/`
first — it's the router.

## Security posture

HyperFrames is a Claude Code plugin marketplace (`.claude-plugin/`). The two
skills we lead with both pass the skill-security-gate (faceless-explainer 17,
slideshow 5 — both SAFE). Re-gate any *other* vendor skill before first use:

```bash
bash Skills/skill-security-gate/scripts/gate.sh Integrations/hyperframes/skills/<name>
```

## Underlying tool

- CLI: `npx -y hyperframes@latest <cmd>` (init, lint, render, preview, doctor,
  inspect, transcribe, tts, capture, publish).
- Source clone: `Integrations/hyperframes/` (heygen-com/hyperframes, Apache-2.0).
- Docs: hyperframes.heygen.com
