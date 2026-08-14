---
name: threejs-game-production
description: Build, upgrade, debug, profile, visually polish, test, and prepare Three.js browser games for release. Use for new Three.js games, existing-game remediation, basic or primitive-looking visuals, asset-backed actor or environment upgrades, WebGL/WebGPU or canvas failures, renderer performance work, mobile input and responsive verification, deterministic playtesting, and premium or release-readiness reviews. Preserve established gameplay contracts and use Zo-native fal.ai media routing rather than Claude-specific commands.
---

# Three.js Game Production

Own the result from baseline through verified browser evidence. Treat existing games as constrained systems: improve the requested surface without replacing working mechanics, collision authority, save data, deterministic hooks, or test contracts.

This skill adapts the useful production concepts from `marlandoj/threejs-game-skills` at pinned commit `7221c1f4a6d2ae189a4d85d058d24f3228499d46` (MIT). The vendored source at `/home/workspace/Integrations/threejs-game-skills` is provenance and an update source, not a required runtime dependency.

## Select The Work Mode

- Use **economy mode** for a narrow bug, one asset integration, or one measured bottleneck. Load only the relevant reference plus `references/diagnostics-and-release.md`.
- Use **thorough mode** for a new game, broad upgrade, premium/AAA/showcase request, or release review. Load all four references before implementation.
- Never claim premium, AAA, showcase, complete, or release-ready based on code inspection alone.

## Run The Workflow

1. Read the project `README.md`, `AGENTS.md`, product/progress documents, package scripts, renderer entrypoint, test harness, and current diagnostics.
2. Run the deterministic audit:

   ```bash
   bun /home/workspace/Skills/threejs-game-production/scripts/audit-project.ts --project /absolute/path/to/game
   ```

3. Write a protected-behavior contract before broad edits. Freeze gameplay rules, collision authority, controls, camera behavior, progression, persistence, public test hooks, and established budgets unless the user explicitly changes them.
4. Capture a baseline in the real browser: active desktop and mobile frames, console/page errors, nonblank canvas evidence, main-loop input, and renderer metrics.
5. Choose the phase path in `references/workflow.md`. For visual changes, follow `references/visual-production.md`. For provider-backed assets, run the credential probe and follow `references/providers.md`.
6. Implement in ownership order: gameplay/data authority, renderer view, UI, diagnostics, then harness. Keep imported visuals separate from collision and game-state authority.
7. Run focused tests early, then typecheck, unit tests, production build, browser tests, active desktop/mobile captures, main objective/fail/retry paths, and renderer-budget comparison.
8. Record evidence, residual risk, asset fallbacks, and any unverified claim. Do not substitute a responding URL for rendered-canvas verification.

## Route The Phases

- **Gameplay and architecture:** core loop, level/encounter plan, input, physics, collision, camera, deterministic state.
- **Visual production:** authored silhouettes, imported assets, materials, grounding, lighting, VFX, environment kit, technical-art budgets.
- **UI:** HUD hierarchy, menus, state coverage, safe areas, touch targets, responsive fit.
- **Debug/profile:** blank canvas, asset loading, resize, animation, frame timing, draw calls, triangles, textures, memory, DPR.
- **QA/release:** production build, browser traversal, deterministic playtest, screenshots, nonblank pixels, mobile, base paths, release risk.

## Enforce The Quality Bar

- Build authored forms before materials, lighting, glow, or post-processing. Primitives with bloom remain prototype assets.
- Use asset-backed hero actors for premium claims when practical. Preserve procedural views as loading/error fallbacks, not as collision authority.
- Measure before optimizing. Change one bottleneck at a time and recapture the same scenario.
- Keep mobile input, resize behavior, DPR caps, and text fit in the primary implementation path.
- Require visible evidence for every user-facing claim. A test suite cannot prove composition, framing, grounding, or canvas output.
- Use Three.js or an established physics/game library for domain behavior; do not replace an existing proven engine without explicit approval.

## Use Media Providers Safely

Run:

```bash
bun /home/workspace/Skills/threejs-game-production/scripts/probe-credentials.ts
```

- Core workflow: no API key.
- Images/concepts/textures/UI art: use `/home/workspace/Skills/fal-ai-media`; requires `FAL_KEY`.
- Generated 3D GLB/FBX assets: optional Tripo path; requires `TRIPO_API_KEY`.
- New generated SFX/voice: optional ElevenLabs path; requires `ELEVENLABS_API_KEY`.

Never place credentials in game code, reports, screenshots, or asset manifests. Report only `SET` or `MISSING`.

## Read References As Needed

- `references/workflow.md`: phase decisions, protected behavior, and evidence ledgers.
- `references/visual-production.md`: asset architecture, visual pass order, and technical-art controls.
- `references/diagnostics-and-release.md`: debugging, renderer metrics, browser QA, and release gates.
- `references/providers.md`: Zo-native image routing and optional 3D/audio provider procedures.

## Report Completion

Lead with pass/fail. Name the protected behaviors, files changed, commands and counts, browser URLs, capture artifacts, renderer metrics, asset/provider evidence, phases skipped with reasons, and remaining blockers. Distinguish “implemented,” “wired,” “rendered,” and “verified.”

