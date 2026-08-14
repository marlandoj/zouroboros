# Collaboration Profile Drift Report

**Scan date:** 2026-05-20  
**Window:** full DB history (fallback — no data in last 90d window)  
**Messages scanned:** 45  
**Baseline frozen:** 2026-05-02 (n=5956)

## Drift Findings (1 flagged)

### Frustration Rate
- **Direction:** up
- **Baseline:** 0.0
- **Current:** 2.22
- **Threshold:** 0.5
- Frustration language detected in 2.22% of messages (1 messages). Baseline is 0%.

## Metrics Comparison

| Metric | Baseline | Current | Delta |
|--------|----------|---------|-------|
| Messages (n) | 5956 | 45 | -5911 |
| Median chars | 72 | 62 | -10 |
| Mean chars | 118 | 106.9 | -11.1 |
| Frustration rate | 0.0 | 0.0222 | +0.02 |

## Recommended Action

Review `file 'Notes/marlandoj-collaboration-profile.md'` and decide whether to refresh the baseline:
```
python3 /home/workspace/Skills/marlandoj-collaboration-profile/scripts/rescan_and_diff.py --update-baseline
```