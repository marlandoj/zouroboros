---
name: Zouroboros evolution-2
description: Handles successful test coverage reports with an undefined delta in Zouroboros evolution episodes.
---

# Zouroboros evolution-2

## When to invoke
- When a Zouroboros evolution episode reports success for `test_coverage` with an undefined delta.
- When the outcome is `success` and the delta is `NaN` percentage points.

## Inputs
- Episode UUID and the `test_coverage` result string (e.g., `undefined succeeded for test_coverage; delta NaN percentage points.`).

## Outputs
- Confirmation that the coverage check succeeded with a `NaN` delta, ready for logging or downstream processing.