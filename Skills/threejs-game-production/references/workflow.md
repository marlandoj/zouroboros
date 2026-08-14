# Workflow And Ledgers

## Phase Decision

Use only the phases the request needs, but always finish with diagnostics and release verification.

| Request | Required phases |
| --- | --- |
| Narrow runtime bug | Debug/profile, QA |
| Visual upgrade | Visual production, debug/profile, QA |
| Gameplay change | Gameplay, UI if state changes, debug/profile, QA |
| New game | Gameplay, visual production, UI, debug/profile, QA |
| Premium/release review | All phases plus provider decision and fresh-eyes capture review |

## Protected-Behavior Contract

Before editing an existing game, record:

- Mechanics, timings, collision authority, and progression that must not change.
- Controls, camera, persistence, routes, and public runtime/test APIs that must remain compatible.
- Existing unit, browser, deterministic, snapshot, and performance gates.
- Current assets and fallbacks that must remain available during async loading failures.

Treat rendering as a view over game state. A GLB mesh, animation mixer, particle effect, or lighting cue must not silently become gameplay authority.

## Evidence Ledgers

Maintain compact tables during substantial work.

### Phase Ledger

| Phase | Status | Evidence | Blocker |
| --- | --- | --- | --- |
| Gameplay | not-needed / active / done | files/tests | reason |
| Visual production | not-needed / active / done | captures/metrics | reason |
| UI | not-needed / active / done | states/viewports | reason |
| Debug/profile | active / done | baseline/post metrics | reason |
| QA/release | active / done | commands/captures | reason |

### Asset Ledger

| Surface | Source | Runtime path | Fallback | Budget evidence |
| --- | --- | --- | --- | --- |
| Player/boss/world/UI/audio | procedural / existing / generated / hybrid | file/loader | named fallback | triangles, textures, bytes, clips |

### Verification Ledger

Record typecheck, unit, build, browser checks, desktop/mobile captures, nonblank pixels, console/page errors, main objective, fail/retry, resize, input, and renderer diagnostics. Mark anything not run as unverified with a reason.

## Existing-Game Exit Conditions

- Protected behavior remains covered and passing.
- Every new capability has a real caller or runtime wiring.
- Imported assets have deterministic loading, bounds/scale validation, lifecycle cleanup, and a visible fallback.
- The production path uses the same hooks and diagnostics exercised by evaluation.
- Browser evidence shows the intended game and canvas, not merely a live port.

