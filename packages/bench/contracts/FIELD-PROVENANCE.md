# ZouroBench v2 artifact — field provenance taxonomy (ZBRE-002)

Every field the `schema_version: 2` producer emits is one of four kinds.
Unavailable evidence is always `{ value: null, availability_reason }` — never
zero, false, or a passing verdict (ZBRE-001 honesty rule).

## Observed — read directly from the environment or a provider response

| Field | Source |
|---|---|
| `provenance.git_commit`, `git_dirty`, `repository.remote` (userinfo scrubbed), `repository.branch` | `git rev-parse` / `status --porcelain` / `config` at run start |
| `provenance.host` | `os.hostname()` |
| `provenance.invocation` | `process.argv` (CLI flags only; secrets never travel on argv) |
| `provenance.recorded_at`, `run.timestamp` | wall clock at artifact assembly |
| `provenance.flags.*` | the allowlisted non-secret configuration itself (models, categories, limit, seeds, minimum_n, timeout, max_answer_tokens, …) |
| `execution.answer_model`, `judge_model`, `embedding_model`, `truncation_guard_enabled`, `generation_timeout_ms` (0 = disabled), `max_tokens` | resolved run configuration |
| `cohort.*` (replicate index/seed label/cohort id/minimum_n/timeout) | replicate loop state |
| `questions[].finish_reason` | provider `finish_reason` of the answer call |
| token counts inside `usage` blocks | provider `usage` counters (numbers only; the raw response object is never stored) |

## Derived — computed deterministically from observed inputs

| Field | Derivation |
|---|---|
| `provenance.dataset_sha256` | SHA-256 over the raw dataset file bytes |
| `provenance.question_set_sha256` | SHA-256 over the canonical JSON of the selected question identities (category filter + limit applied), in run order |
| `provenance.config_fingerprint` | SHA-256 over the canonical JSON of `provenance.flags` (fail-closed guard rejects secret-like keys) |
| `cohort.replicate_seed` | numeric seed; non-numeric seed labels are FNV-1a hashed (label preserved in `replicate_seed_label`) |
| `usage` (run level), `questions[].usage` | sums of observed per-call counters (answer + judge calls) |
| `usage_coverage` | observed vs. unobserved provider-call counts |
| `parity` | question-id pairing and accuracy delta against the `--parity-baseline` artifact (read through the v1/v2 contract normalizer) |
| `errors[]` | structured run errors (generation timeouts, consensus error verdicts) |

## Estimated — snapshot arithmetic, not a provider invoice

| Field | Basis |
|---|---|
| `pricing` (incl. `by_model`, `as_of`) | static USD/1M-token table frozen at `PRICING_SNAPSHOT.as_of`; `source` says "estimated". A model absent from the table makes pricing **unavailable** rather than partially costed. |

Not included in usage/pricing (documented gaps, visible via `usage_coverage`):
embedding calls, consensus-gate CLI internals, and `byok:` zo/ask calls (the
endpoint returns no usage counters).

## Unavailable — honest nulls

| Field | When |
|---|---|
| `usage`, `pricing` | no provider call returned counters (e.g. pure `byok:` run) |
| `questions[].usage` | that question's calls returned no counters |
| `execution.judge_model` | heuristic judge (no LLM judge configured) |
| `parity` | no `--parity-baseline` passed, or the baseline fails contract validation |
| `consensus.threshold/invocations/splits` | consensus gate disabled |
| git fields | git itself failed (`git_commit: "unavailable"`, `git_status: "unavailable"`) |

## Legacy compatibility

The v2 artifact is a strict superset of the legacy v1 shape: every legacy
top-level field (`benchmark`, `timestamp`, `dataset`, `total_questions`,
`answered`, `scores`, `latency`, `consensus_gate`, `profile_valve_shadow`,
`replicate`, `questions` core fields) is byte-identical to what the v1
producer wrote. `report.ts`, `regression-gate.ts`, and the ZBRE-001
normalizer read both versions unchanged.
