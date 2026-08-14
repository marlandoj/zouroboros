#!/usr/bin/env bun
/**
 * verdict.ts — explain the verdict logic, or compute verdict from a findings file.
 *
 *   bun verdict.ts --explain
 *   bun verdict.ts --findings findings.json
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { computeVerdict, VERDICT_EMOJI, VERDICT_LABEL } from "./lib/verdict.ts";
import type { AuditReport } from "./lib/types.ts";

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      explain: { type: "boolean", default: false },
      findings: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help || (!values.explain && !values.findings)) {
    console.log(`
verdict.ts — verdict utilities

Usage:
  bun verdict.ts --explain               # show verdict thresholds
  bun verdict.ts --findings findings.json # recompute verdict from an existing audit
`);
    process.exit(0);
  }

  if (values.explain) {
    console.log(`
Verdict = worst( findings gate , coverage gate )
================================================

The verdict is the WORSE of two independent gates.

1. Findings gate — what problems did we find?
   🔴 do-not-launch          — ANY critical finding OR any hard blocker
   🟠 private-beta-only      — 0 critical, but 1+ high findings
   🟡 launch-with-monitoring — 0 critical, 0 high, but > maxMedium (default 3)
   🟢 launch-ready           — 0 critical, 0 high, ≤ maxMedium

2. Coverage gate — did we actually look? Caps the verdict:
   🚧 blocking gap  → capped at private-beta-only
        · ≥ 2 core scanners missing (gitleaks / semgrep / osv-scanner)
        · a security-critical domain errored or could not run
   • soft gap       → capped at launch-with-monitoring
        · exactly 1 core scanner missing
        · a domain ran with reduced/partial coverage
        · no --url (runtime/browser surface not exercised)
        · critical manual checks not signed off (pass --manual-verified)

  ⇒ An INCOMPLETE audit can never be launch-ready, even with zero findings.
     A clean-but-blind scan is NOT a pass.

Exit codes: 3 / 2 / 1 / 0 (do-not-launch / private-beta / monitoring / ready).

Hard blockers (always force do-not-launch)
------------------------------------------
- Private API keys exposed in frontend or live secret in repo
- Unprotected admin routes
- Cross-tenant data access (BOLA / no RLS)
- Public paid-API endpoint with no rate limit
- Unverified payment webhooks
- PII / secrets written to logs
- Unsafe file uploads
- Database accessible from frontend without RLS
- JWT alg=none accepted
- if False around a security check
`);
    process.exit(0);
  }

  const data = JSON.parse(readFileSync(values.findings as string, "utf8")) as AuditReport;
  const allFindings = data.results.flatMap((r) => r.findings);
  // Reuse the persisted coverage assessment so the recomputed verdict matches.
  const v = computeVerdict(allFindings, data.coverage);
  console.log(`${VERDICT_EMOJI[v.verdict]} ${VERDICT_LABEL[v.verdict]}`);
  console.log(v.reason);
  console.log(`scores: ${JSON.stringify(v.scores)}`);
  if (v.hardBlockers.length) {
    console.log(`hard blockers (${v.hardBlockers.length}):`);
    for (const f of v.hardBlockers) console.log(`  - ${f.id}: ${f.title}`);
  }
  process.exit(v.exitCode);
}

main();
