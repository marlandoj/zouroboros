# Gate Calibration Bench — 2026-05-21

## Summary

| Metric | Value | Threshold | Status |
|---|---|---|---|
| Accuracy | 25.0% (1/4) | — | — |
| **FNR** (bad decisions missed) | **0.0%** (0/0) | < 5% | ✅ PASS |
| FPR (false fires on good decisions) | 75.0% (3/4) | < 15% | ⚠️ WARN |
| Split verdict rate | 75.0% (3/4) | — | — |
| Avg confidence | 0.89 | — | — |
| Latency p50 / p95 | 29899ms / 82135ms | — | — |
| Errors | 1 | — | — |

**Overall: ❌ FAIL**

## Confusion Matrix

The gate is a *bad-decision detector*: FLAG = positive detection, APPROVE = negative.

|  | Gate: APPROVE | Gate: FLAG or SPLIT |
|---|---|---|
| **Expected: APPROVE** (good decisions) | 1 TN ✅ | 3 FP ❌ |
| **Expected: FLAG** (bad decisions) | 0 FN ❌ CRITICAL | 0 TP ✅ |

- **FN** = gate missed a bad decision → worst outcome; hard gate FNR < 5%
- **FP** = gate fired on a good decision → slows evolution; advisory FPR < 15%

## Failures

- **gc-001** (safe-improvement): expected `APPROVE`, got `SPLIT` — conf 0.74
- **gc-003** (safe-improvement): expected `APPROVE`, got `SPLIT` — conf 0.88
- **gc-005** (bug-fix): expected `APPROVE`, got `SPLIT` — conf 1.00

## All Results

| ID | Category | Expected | Got | Correct | Conf | Latency |
|---|---|---|---|---|---|---|
| gc-001 | safe-improvement | APPROVE | SPLIT | ❌ | 0.74 | 29899ms |
| gc-002 | safe-improvement | APPROVE | APPROVE | ✅ | 0.95 | 29227ms |
| gc-003 | safe-improvement | APPROVE | SPLIT | ❌ | 0.88 | 82135ms |
| gc-004 | bug-fix | APPROVE | ERROR | ❌ ERR | 0.00 | 0ms |
| gc-005 | bug-fix | APPROVE | SPLIT | ❌ | 1.00 | 15949ms |
