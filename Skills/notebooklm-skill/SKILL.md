---
name: notebooklm-skill
description: >
  Automate Google NotebookLM for course content production: create notebooks, upload sources,
  generate audio overviews, quizzes, flashcards, slide decks, and video overviews.
  Includes a Podcastfy/Gemini fallback pipeline for durable podcast generation without
  NotebookLM dependency. Primary use case: Zouroboros Academy content at scale.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
  version: "1.0.0"
---

# NotebookLM Skill

Automate course content production using Google NotebookLM and a durable Gemini+TTS fallback.

## Prerequisites

- `notebooklm-py` (pip install notebooklm-py) — installed
- `podcastfy` (pip install podcastfy) — installed
- Google account authenticated via `notebooklm login`
- Optional: `GEMINI_API_KEY` in Zo secrets for fallback pipeline
- Optional: `ELEVENLABS_API_KEY` in Zo secrets for premium TTS (Starter plan active as of 2026-04-05)

## Authentication

Session cookies are stored at `~/.notebooklm/storage_state.json`. Two methods to authenticate:

### Method A: CLI Login (local machine only)

```bash
pip install notebooklm-py playwright
python -m playwright install chromium
notebooklm login
```

This opens Chromium for Google OAuth. Upload the resulting `storage_state.json` to Zo.

> **Note:** The CLI login may crash with a Playwright navigation error after Google redirects. If this happens, check if `~/.notebooklm/storage_state.json` was saved anyway. If not, use Method B.

### Method B: Cookie Re-Export (recommended for Zo)

When the session expires or Method A fails, re-export cookies from your browser:

1. Install the **Cookie-Editor** Chrome extension (by cgagnier — not "Cookie Editor" by HotCleaner)
2. Navigate to `notebooklm.google.com` in Chrome (make sure you're signed in)
3. Click the **Cookie-Editor icon** in the browser toolbar (cookie-shaped icon, top-right)
4. Click **Export** at the bottom of the popup — copies JSON to clipboard
5. Save the JSON to a file (e.g., `cookies.json`)
6. Upload `cookies.json` to Zo workspace
7. Run the converter:

```bash
python /home/workspace/Skills/notebooklm-skill/scripts/nlm.py import-cookies cookies.json
```

The critical cookies (all must be present):

| Cookie | Domain | Purpose |
|--------|--------|---------|
| `SID` | `.google.com` | Primary session |
| `HSID`, `SSID` | `.google.com` | HttpOnly session pair |
| `APISID`, `SAPISID` | `.google.com` | API auth |
| `__Secure-1PSID`, `__Secure-3PSID` | `.google.com` | Secure session tokens |
| `__Secure-1PSIDTS`, `__Secure-3PSIDTS` | `.google.com` | Session timestamps |
| `__Secure-1PSIDCC`, `__Secure-3PSIDCC` | `.google.com` | Session check |
| `OSID`, `__Secure-OSID` | `notebooklm.google.com` | **NotebookLM-specific (critical)** |
| `NID` | `.google.com` | Device/preferences |

> **Important:** `OSID` and `__Secure-OSID` are the most commonly missing cookies — without them, all API calls fail silently. They live on the `notebooklm.google.com` domain (not `.google.com`), so cookie exports from the wrong page will miss them. Always export while on `notebooklm.google.com`.

### Session Refresh

Google sessions typically last 2–4 weeks. When API calls return 401/403 or fail silently, re-export cookies using Method B above.

### Automated Session Keepalive

Two scheduled agents keep the session warm so scheduled notebook workflows can run without manual re-auth:

- **NotebookLM Keepalive** — runs every 4 days at 3:00 AM. Executes `scripts/keepalive.py` which headlessly visits `notebooklm.google.com` with stored cookies, lets Google rotate the short-lived `SIDTS`/`OSID` tokens, and re-exports `storage_state.json`. As long as the master `SID` stays valid (~6–12 months), this loops indefinitely.
- **NotebookLM Health Check** — runs daily at 6:00 AM. Executes `scripts/keepalive.py --check-only` which validates the session without mutating storage_state. SMS-alerts the user on hard failure only (silent on success).

On hard failure (Google force-logout, password change, security challenge), the user receives an SMS with the 90-second Cookie-Editor re-export recipe. Expect ~3 manual re-exports per year instead of every 2–4 weeks.

Logs: `~/.notebooklm/keepalive.log` (append-only, ISO-8601 timestamps).
Backup: `~/.notebooklm/storage_state.json.bak` (previous cookies, kept in case refresh yields a broken state).

## Scripts

### `scripts/nlm.py` — Full Studio CLI

Orchestrates all NotebookLM Studio operations for course content production.

**Commands:**

| Command | Description |
|---------|-------------|
| `list` | List all notebooks |
| `status` | Show auth status and notebook count |
| `create-module` | Create a notebook with sources |
| `add-sources` | Add files/URLs to existing notebook |
| `generate` | Generate a single artifact type |
| `generate-all` | Generate all artifact types (kitchen sink) |
| `generate-classroom` | Generate Skool-optimized suite (7 artifacts) |
| `export` | Download all available artifacts from a notebook |
| `ask` | Chat with a notebook |
| `batch-modules` | Batch: create notebooks + basic artifacts for all modules |
| `batch-classroom` | Batch: create notebooks + full classroom suite for all modules |
| `import-cookies` | Convert Cookie-Editor JSON to storage_state.json |

**Artifact Types & Options:**

| Type | Formats/Styles | Output |
|------|---------------|--------|
| `audio` | deep-dive, brief, critique, debate × short/default/long | `.mp3` |
| `video` | explainer, brief, cinematic × 10 styles (classic, whiteboard, kawaii, anime, watercolor, retro-print, heritage, paper-craft, auto, custom) | `.mp4` |
| `cinematic-video` | Separate high-quality cinematic generation | `.mp4` |
| `slide-deck` | detailed, presenter × default/short | `.pdf` |
| `infographic` | 11 styles (professional, sketch-note, bento-grid, editorial, instructional, bricks, clay, anime, kawaii, scientific, auto) × landscape/portrait/square × concise/standard/detailed | `.png` |
| `mind-map` | Source selection | `.png` |
| `quiz` | easy/medium/hard × fewer/standard + custom instructions | `.json` |
| `flashcards` | easy/medium/hard × fewer/standard + custom instructions | `.json` |
| `report` | briefing, study-guide, blog-post, custom (with custom prompt) | `.md` |
| `study-guide` | Extra instructions | `.md` |
| `data-table` | Instructions | `.json` |

All generators accept `--instructions` for custom guidance and `--timeout` (default 600s).

**Examples:**

```bash
# Single artifact with full options
python nlm.py generate --notebook <id> --type video --video-format explainer --video-style whiteboard
python nlm.py generate --notebook <id> --type infographic --infographic-style bento-grid --infographic-orientation landscape --infographic-detail detailed
python nlm.py generate --notebook <id> --type quiz --quiz-difficulty hard --quiz-quantity standard --instructions "Focus on practical application"
python nlm.py generate --notebook <id> --type report --report-format custom --custom-prompt "Create a lesson summary for beginners"

# Classroom suite (Skool-optimized: video + audio + slides + infographic + study guide + quiz + flashcards)
python nlm.py generate-classroom --notebook <id> --output ./output/module-1/ --video-style classic --infographic-style professional

# Kitchen sink (all artifact types)
python nlm.py generate-all --notebook <id> --output ./output/module-1/ --include-data-table

# Batch all modules with classroom suite
python nlm.py batch-classroom --guides ONBOARDING_GUIDES.md --output ./output/ --video-style classic

# Import cookies from Cookie-Editor extension
python nlm.py import-cookies cookies.json
```

### `scripts/brain_dump_export.py` & `brain_dump_run.py` — Weekly Brain Dump Podcast

Personal synthesis pipeline. Exports the last 7 days of memory (facts, episodes, open loops, scorecard telemetry) into a markdown brief, uploads it to NotebookLM, generates a 15-22 min deep-dive audio, and emails it to the user. Runs weekly via the "Weekly Brain Dump" agent (Sundays, 6 PM Phoenix).

```bash
python3.12 scripts/brain_dump_export.py --days 7 --out brief.md   # Brief only
python3.12 scripts/brain_dump_run.py                              # Full pipeline
python3.12 scripts/brain_dump_run.py --dry-run                    # Export only
```

Outputs land in `/home/workspace/Documents/BrainDumps/`:
- `brain-dump-YYYY-MM-DD.md` — the source brief
- `brain-dump-YYYY-MM-DD.mp3` — the audio deep-dive

The brief is pulled from `mimir.db`, `shared-facts.db`, and `scorecard.db`. Generic documentation "must" statements are filtered out of open_loops so the synthesis focuses on real personal commitments.

### `scripts/recurse.py` & `recurse_weekly.py` — Adversarial Debate Recursion

Self-improving synthesis loop. Drops a draft into a NotebookLM notebook with an adversarial Critic Brief, generates a two-host DEBATE audio (steelman vs. attack), transcribes via Whisper (auto-chunks >24 MB files), extracts structured objections via gpt-4o, and writes each objection as a `source=notebooklm-critique` fact in `mimir.db`.

```bash
python3.12 scripts/recurse.py --draft path/to/draft.md [--iteration N]   # One-shot
python3.12 scripts/recurse_weekly.py [--skip-if-exists]                  # Auto-select latest brain-dump
```

`recurse_weekly.py` finds the most recent `brain-dump-YYYY-MM-DD.md` in `/home/workspace/Documents/BrainDumps/`, runs `recurse.py` against it, publishes artifacts via `zopub sync brain-dumps`, and emits JSON on stdout (draft, iteration, objection counts by category + severity, top 3 objections, zo.pub links, notebook URL) for the scheduled agent to email.

Runs weekly via **Weekly Adversarial Debate Critique** agent (Mondays, 6 AM Phoenix — ~12 hours after the Brain Dump agent completes). Requires `OPENAI_API_KEY` in Zo secrets. Outputs land in `/home/workspace/Documents/BrainDumps/critiques/`:
- `critique-brain-dump-YYYY-MM-DD-iterN.mp3` — debate audio (~22 min / 40 MB)
- `transcript-brain-dump-YYYY-MM-DD-iterN.txt` — Whisper transcript
- `objections-brain-dump-YYYY-MM-DD-iterN.json` — structured objections
- `summary-brain-dump-YYYY-MM-DD-iterN.json` — run summary + mimir IDs

### `scripts/agent_research.py` & `notebook-capture.sh` — Per-Agent Research Notebooks

Turns ephemeral scheduled-agent output (web_research, eval reports, gap audits, diagnostics) into a durable, queryable NotebookLM knowledge base. Each agent slug maps to its own notebook; repeated runs append new dated sources.

**Registry:** `~/.notebooklm/agent_notebooks.json` — `{slug → {notebook_id, title, source_count, last_append_at}}`. Notebook is auto-created on first `append`.

**Commands:**

```bash
# Append agent output as a new source (auto-creates notebook on first use)
notebook-capture memory-diagnostic --file /tmp/report.md --tag diagnostic
echo "report content" | notebook-capture memory-diagnostic --title "2026-04-23 nightly"

# Query the accumulated knowledge base conversationally
python3.12 agent_research.py ask memory-diagnostic --question "what concerns have recurred in the last month?"

# Inventory
python3.12 agent_research.py list
python3.12 agent_research.py url memory-diagnostic

# Bind an existing notebook instead of auto-creating
python3.12 agent_research.py register memory-diagnostic --notebook <nb-id>
```

**Agent integration pattern.** In any scheduled agent's instruction, after producing a markdown report, add one line:

```bash
/home/workspace/Skills/notebooklm-skill/scripts/notebook-capture.sh <agent-slug> --file /path/to/report.md
```

Each source is prefixed with a timestamp header so NotebookLM's citations point to the right run. Use `ask` from chat or another agent to query accumulated history (e.g. "what did the eval agent flag about the gate last week?") instead of re-reading dozens of files.

### `scripts/keepalive.py` — Session Refresh

Headless Chromium session warmer. Opens `notebooklm.google.com` with stored cookies so Google rotates the short-lived session tokens, then re-saves `storage_state.json`. Invoked by the Keepalive and Health Check agents.

```bash
python3.12 scripts/keepalive.py               # Refresh cookies
python3.12 scripts/keepalive.py --verbose     # Print log to stdout
python3.12 scripts/keepalive.py --check-only  # Validate without refresh
```

Exit codes: `0` success, `1` hard failure (manual re-auth required), `2` soft/transient failure.

### `scripts/podcast-gen.py` — Fallback Pipeline (Gemini + TTS)

Durable podcast generation without NotebookLM dependency. Uses Gemini API for script
generation and ElevenLabs/Google TTS for audio.

```bash
python scripts/podcast-gen.py --source guide.md --output podcast.mp3
python scripts/podcast-gen.py --source guide.md --output podcast.mp3 \
  --host-voice "Rachel" --guest-voice "Adam" --length 10
python scripts/podcast-gen.py --batch-dir /path/to/modules/ --output-dir ./podcasts/
```

## Classroom Suite

The `generate-classroom` and `batch-classroom` commands produce the ideal Skool module content mix:

1. **Video Overview** (explainer, classic style) — primary lesson content
2. **Audio Overview** (deep-dive, default length) — supplemental podcast for on-the-go
3. **Slide Deck** (detailed) — downloadable reference material
4. **Infographic** (professional, landscape, standard detail) — visual summary
5. **Study Guide** — structured notes for review
6. **Quiz** (medium difficulty, standard quantity) — knowledge assessment
7. **Flashcards** (medium difficulty, standard quantity) — spaced repetition review

Each artifact is saved to the module output directory with a `manifest.json` tracking all generated files.

## Workflow: Zouroboros Academy Content Pipeline

1. **Prepare guides** — Each module section in `ONBOARDING_GUIDES.md` becomes a notebook source
2. **Batch generate** — `nlm.py batch-classroom --guides ONBOARDING_GUIDES.md --output ./output/`
3. **Review artifacts** — Check video, audio, infographics per module in `output/module-N/`
4. **Upload to Skool** — Attach artifacts to corresponding Skool module lessons
5. **Supplement** — Use `podcast-gen.py` for additional audio content or AI character dialog

## Limits (NotebookLM)

- 500 notebooks per user
- 300 sources per notebook
- 200 MB or 500K words per source
- 20 audio overviews per day
- 500 queries per day

## Notes

- **Python version**: Use `python3.12` on Zo (notebooklm-py is installed in 3.12 site-packages)
- **Video and slide deck generation**: These are the heaviest artifacts and may take 5-10 minutes. The script polls with exponential backoff up to the timeout.
- **Mind map**: Returns immediately (no async generation) — outputs a JSON structure rendered to PNG.
- **Audio**: 3-5 minutes typical generation time. The 42 MB deep-dive for Module 1 took ~4 minutes.