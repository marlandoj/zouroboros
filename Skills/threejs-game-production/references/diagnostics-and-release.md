# Diagnostics And Release

## Debug Order

1. Reproduce in the correct dev or production mode.
2. Read page, console, and network errors.
3. Verify canvas CSS size, drawing-buffer size, context, camera, scene contents, render loop, and resize ownership.
4. Verify asset URLs, base path, CORS, loaders, decoders, animation clips, and audio gesture unlock.
5. Verify update order, delta units, fixed timestep, collision ownership, listeners, pause/restart cleanup, and mobile pointer behavior.
6. Fix the owning module and retest the broken path.

## Required Runtime Metrics

Expose or capture, where relevant:

- FPS or frame-time percentiles under a stable clock.
- Draw calls and triangles from `renderer.info.render`.
- Geometry and texture counts from `renderer.info.memory`.
- Particle capacity/active count, entity count, and loaded asset status.
- Renderer/context type, software-rendering indication, viewport, DPR, and canvas buffer size.

Budgets are project-specific. Establish a baseline and an explicit target; do not declare success from generic thresholds alone.

## Browser Evidence

- Verify a nonblank canvas with pixel statistics or canvas-pixel checks.
- Capture active desktop and mobile frames after hydration and gameplay start.
- Exercise the primary input, objective progression, fail/death, restart, pause/resume, resize, and touch paths that exist.
- Confirm HUD text fit, safe areas, touch targets, and no incoherent overlap.
- Use stable state hooks and seeded paths when available. Do not add benchmark-only behavior that production cannot invoke.
- Confirm the URL renders the intended game identity and WebGL scene; ports are reusable and therefore not durable evidence.

## Mechanical Gate

Run the project’s own commands in this order when available: focused tests, TypeScript/typecheck, unit tests, production build, browser/end-to-end tests, production preview inspection. Treat every TypeScript error as a blocker.

## Release Gate

Review base paths, static asset paths, debug/test UI gating, source maps, bundle and largest assets, caching assumptions, error fallbacks, and deployment command. Report skipped tests and residual risks plainly.

