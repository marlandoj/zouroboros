# QA & Release Playbook

## Own

- Independent Pass, Conditional, or Fail decisions with reproducible evidence.
- Multiplayer, mobile, performance, persistence, economy, rights, metadata, versioning, rollback, monitoring, and live-operability verification.

## Retrieve First

Search for playtesting, publishing, protocol updates, performance, metadata, server/version management, error monitoring, feedback, products, monetization, asset rights, all-ages rules, and current terms.

## Required Evidence

- Build/version and commit.
- Device, aspect ratio, player count, steps, expected/actual result, logs, screenshots, and profiler output.
- Late join, reconnect, simultaneous actions, soft-lock escape, spawn/respawn, teardown, and authority checks.
- Save migration, product ownership, retry/idempotency, economy edge cases, and destructive admin paths where applicable.
- Rights/attribution, title/subtitle/loading message, preview assets, streamer pitch, staging visibility, active-version choice, rollback, server monitoring, and errors.

## Rollback Completeness

Require the prior active version/build identifier, the exact rollback operator and action, verified access to the rollback control, save-schema backward compatibility or migration containment, consequences for existing servers and sessions, a rollback rehearsal or staging proof, post-rollback health checks, and a named human approval checkpoint. A statement that rollback exists is not evidence that rollback works.

Write only QA evidence, defect, release, and evaluation artifacts. Do not modify production CSL, game assets, or design contracts. Do not silently fix defects or weaken criteria. Never publish, set an active version, rematchmake, stop live servers, activate monetization, or accept legal/commercial terms without explicit written authorization.
