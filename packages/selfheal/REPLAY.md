# Local deterministic replay

Zouroboros records secret-redacted HTTP and ACP tool interactions into local cassettes and replays them without network access. Replay evidence is shared by ZouroBench, Snakepit, and skill crystallization.

## Storage

- ACP tool traces: `~/.zouroboros/replay/traces/<trace_id>/<task_id>.json`
- Regression corpus: `Seeds/zouroboros/replay/*.json`
- Cassette files are written with mode `0600`.
- Authorization, cookies, credentials, token-shaped values, sensitive query parameters, and sensitive JSON fields are redacted before persistence.
- Set `ZOUROBOROS_TRACE_RECORD=0` to disable automatic ACP capture.
- Set `ZOUROBOROS_REPLAY_ROOT` to move the local trace store.

## Record and replay a Bun workflow

```bash
zouroboros-replay record \
  --cassette Seeds/zouroboros/replay/cassettes/example.json \
  --trace Seeds/zouroboros/replay/cassettes/example.trace.json \
  --trace-id example-trace \
  -- packages/example-client.ts

zouroboros-replay replay \
  --cassette Seeds/zouroboros/replay/cassettes/example.json \
  --trace Seeds/zouroboros/replay/cassettes/example.trace.json \
  -- packages/example-client.ts
```

Record mode permits real network calls. Replay mode strips the parent environment to an allowlist, removes secrets, refuses egress through an unbindable proxy, and serves recorded responses through a Bun preload.

## Promote a failure into regression gates

```bash
zouroboros-replay export \
  --id example-regression \
  --title "Example production failure" \
  --cassette Seeds/zouroboros/replay/cassettes/example.json \
  --trace Seeds/zouroboros/replay/cassettes/example.trace.json \
  --entrypoint packages/example-client.ts \
  --targets zourobench,snakepit
```

The ZouroBench regression gate and live Snakepit sweep run every matching corpus case. A mismatch, missing fixture, unconsumed interaction, or integrity error blocks the gate.

For a crystallized skill, include `crystallization` in `--targets` and supply both:

```bash
--crystallization-slug example-skill \
--candidate-entrypoint scripts/run.ts
```

The crystallization scan executes the candidate entrypoint against the fixture. Replay failure rejects the candidate before an approval email is created.

## Promotion policy

```bash
zouroboros-crystallize approve <id> --token <token> --automated
```

Automated promotion requires `eval_status=replay_pass`. `mechanical_only`, `mechanical_pass`, and `replay_fail` are blocked. Manual approval remains available as an explicit human override.
