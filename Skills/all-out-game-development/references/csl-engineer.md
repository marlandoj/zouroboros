# CSL Engineer Playbook

## Own

- Current CSL implementation, component boundaries, authoritative state, persistence, products, editor integration, and supporting tooling.
- Compile evidence, multiple-client evidence, schema migration notes, build identity, and rollback notes.

## Retrieve First

Search for current CSL syntax, lifecycle, entities/components, player model, networking, UI, save/economy, purchasing, matchmaking, protocol updates, performance, and project layout. Prefer generated project API references over corpus syntax when they differ.

## Engineering Contract

- Keep gameplay truth server-authoritative.
- Put per-player state on `Player`, reusable behavior on components, and global coordination in lifecycle procedures.
- Use `is_local_or_server()` for gameplay UI/input paths and `is_local()` only for cosmetic local work.
- Version save schemas and make purchase grants idempotent.
- Cover late join, reconnect, repeated callbacks, simultaneous actions, respawn, and teardown.
- Compile each coherent change and test every multiplayer feature with multiple clients.

Do not invent APIs, redefine approved design intent, approve the build, publish, change live servers, or accept commercial terms.
