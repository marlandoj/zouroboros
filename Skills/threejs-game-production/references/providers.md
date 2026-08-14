# Providers And Secrets

## Core Workflow

Auditing, implementation, procedural assets, profiling, Playwright verification, and release checks require no external API key.

## Images Through fal.ai

Use `/home/workspace/Skills/fal-ai-media/SKILL.md` and its CLI. This is the required Zo route for concepts, reference sheets, textures, backplates, decals, logos, icons, and UI art.

Secret: `FAL_KEY`.

Save generated images under `/home/workspace/Images/`, then deliberately copy or integrate approved runtime assets into the game. Never call fal.ai from browser code.

## Optional 3D Through Tripo

Secret: `TRIPO_API_KEY`.

Use only when generated GLB/FBX assets are requested or materially needed for a premium hero surface. The pinned upstream tooling is available under `/home/workspace/Integrations/threejs-game-skills/skills/threejs-3d-generator/`. Download outputs immediately, inspect them offline, and commit only approved game assets. Never expose the key client-side.

## Optional Audio Through ElevenLabs

Secret: `ELEVENLABS_API_KEY`.

Use only when generating new SFX, ambience, or voice. Existing or local audio integration needs no provider key. The pinned upstream tooling is available under `/home/workspace/Integrations/threejs-game-skills/skills/threejs-audio-generator/`.

## Credential Reporting

Run `scripts/probe-credentials.ts` and report only `KEY=SET` or `KEY=MISSING`. A missing optional key blocks only its provider-backed phase, not the core skill.
