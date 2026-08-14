# Rubric Rewrite A/B Report — v1 → v2

Generated: 2026-08-02T15:33:38.918Z
Draft source: **deterministic scaffold**
Model: `hf:zai-org/GLM-5.2`

> **ADVISORY.** This proposes a rubric successor and measures it. It does NOT edit
> consensus-gate.ts. Approve `rubric.v2.md` before any change ships.

## Annotation patterns (training cohort)

```json
{
  "total": 0,
  "overEscalateClean": 0,
  "overEscalateDefect": 0,
  "dissentNoise": 0,
  "dissentMiss": 0,
  "byCategory": {}
}
```

## Proposed additive clauses

_none derived_

## A/B on calibration seed (test-cases.json)

```
Running A/B on 28 cases × 2 versions with hf:zai-org/GLM-5.2 ...
  old 1/28 cases  old 2/28 cases  old 3/28 cases  old 4/28 cases  old 5/28 cases  old 6/28 cases  old 7/28 cases  old 8/28 cases  old 9/28 cases  old 10/28 cases  old 11/28 cases  old 12/28 cases  old 13/28 cases  old 14/28 cases  old 15/28 cases  old 16/28 cases  old 17/28 cases  old 18/28 cases  old 19/28 cases  old 20/28 cases  old 21/28 cases  old 22/28 cases  old 23/28 cases  old 24/28 cases  old 25/28 cases  old 26/28 cases  old 27/28 cases  old 28/28 cases
  new 1/28 cases  new 2/28 cases  new 3/28 cases  new 4/28 cases  new 5/28 cases  new 6/28 cases  new 7/28 cases  new 8/28 cases  new 9/28 cases  new 10/28 cases  new 11/28 cases  new 12/28 cases  new 13/28 cases  new 14/28 cases  new 15/28 cases  new 16/28 cases  new 17/28 cases  new 18/28 cases  new 19/28 cases  new 20/28 cases  new 21/28 cases  new 22/28 cases  new 23/28 cases  new 24/28 cases  new 25/28 cases  new 26/28 cases  new 27/28 cases  new 28/28 cases

=== Metrics (vs ground truth) ===
  metric          rubric.v1rubric.v2.proposed        Δ
  accuracy            95.5%    94.4%    -1.0%
  defect_recall      100.0%   100.0%    +0.0%
  clean_pass          85.7%    83.3%    -2.4%
  (call errors — rubric.v1: 6, rubric.v2.proposed: 10)

=== Verdict flips: 10 ===
  cal-002: True -> None (expected True) ✗ away from truth
  cal-008: False -> None (expected False) ✗ away from truth
  cal-009: False -> None (expected False) ✗ away from truth
  cal-010: None -> True (expected True) ✓ toward truth
  cal-011: False -> None (expected False) ✗ away from truth
  cal-012: False -> None (expected False) ✗ away from truth
  cal-013: True -> None (expected True) ✗ away from truth
  cal-014: None -> False (expected False) ✓ toward truth
  cal-022: False -> True (expected True) ✓ toward truth
  cal-026: True -> False (expected True) ✗ away from truth
```

## A/B on HELD-OUT set (reconciled-holdout.json) — anti-Goodhart, report-only

```
Running A/B on 8 cases × 2 versions with hf:zai-org/GLM-5.2 ...
  old 1/8 cases  old 2/8 cases  old 3/8 cases  old 4/8 cases  old 5/8 cases  old 6/8 cases  old 7/8 cases  old 8/8 cases
  new 1/8 cases  new 2/8 cases  new 3/8 cases  new 4/8 cases  new 5/8 cases  new 6/8 cases  new 7/8 cases  new 8/8 cases

=== Metrics (vs ground truth) ===
  metric          rubric.v1rubric.v2.proposed        Δ
  accuracy           100.0%    80.0%   -20.0%
  defect_recall      100.0%   100.0%    +0.0%
  clean_pass         100.0%    66.7%   -33.3%
  (call errors — rubric.v1: 4, rubric.v2.proposed: 3)

=== Verdict flips: 1 ===
  rec-lol2ak: None -> False (expected True) ~ both wrong
```
