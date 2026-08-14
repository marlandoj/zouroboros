# Result Contract Consumer Status

The versioned result contract in `result-contract.ts` is the canonical producer-side
normalizer and aggregator for ZouroBench artifacts. It is covered by the contract tests
and is intentionally not imported by an executable Results Explorer in this repository.

Consumer status: **explicitly deferred**.

The named consumer is the separate private site at
`/home/workspace/Sites/zourobench-results-explorer`. Its read-only API will import
`normalizeResultArtifact` for single-run view models and `aggregateArtifacts` for
cohort-level totals once that site implementation is present. Until then, the bench
package remains the sole executable contract consumer and no second normalization path
should be introduced.
