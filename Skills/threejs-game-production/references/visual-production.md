# Visual Production

## Pass Order

1. Capture representative desktop and mobile frames.
2. Identify the largest mismatch in art direction, silhouette, grounding, scale, or material language.
3. Establish asset ownership and loading before adding detail.
4. Build or import authored forms.
5. Align materials, texture density, scale, pivots, and bounds.
6. Add contact shadows, decals, local lights, fog, and color grading only after geometry reads correctly.
7. Tie VFX to gameplay events and keep telegraphs readable.
8. Re-measure the same frame and play path.

## Asset Architecture

- Use `GLTFLoader` for GLB/GLTF and `AnimationMixer` for clips.
- Keep a typed registry for URLs, expected bounds, scale, orientation, animation names, and fallback factories.
- Cache source assets, clone instances safely, and define who disposes geometry, materials, and textures.
- Ignore late async completion after view disposal.
- Keep procedural actors visible until the replacement is loaded and validated.
- Verify scale, pivot, bounding box, triangle count, materials, textures, animation clips, and compressed asset support.

## Authored Procedural Fallbacks

Fallbacks should preserve silhouette and state readability, not imitate fidelity with glow. Use layered proportions, bevels, tapered forms, material zones, readable joints, contact treatment, and animation poses. Share geometry and materials where ownership permits.

## Technical-Art Controls

- Track draw calls, triangles, geometries, textures, shader/post-processing passes, particle capacity, and DPR.
- Prefer instancing, shared materials, atlases, LOD, culling, and bounded particle pools.
- Keep shadow casters selective. Tune resolution and update frequency to the camera and play scale.
- Compress large opaque textures and models deliberately; verify the deployed decoder path.
- Compare budgets in the same game state, viewport, DPR, and build mode.

## Visual Review

Review active gameplay rather than title screens alone. Check art-direction cohesion, hero silhouette, enemy/boss readability, world density, grounding, material response, lighting depth, VFX clarity, UI hierarchy, mobile framing, and measured performance. Premium claims require no category to remain visibly prototype-grade.

