#!/usr/bin/env bun
/**
 * CI-only structural check for the governing documents.
 *
 * This is a deliberately narrower subset of
 * Skills/zouroboros-governance/scripts/constitution-gate.ts `verify-docs`.
 * That script also diffs this repo's copies against a mirror at
 * /home/workspace/{ZOUROBOROS.md,CONSTITUTION.md} — a comparison that only
 * makes sense inside the live Zo Computer workspace, where both the repo
 * and its outer mirror exist side by side. A GitHub Actions runner checks
 * out only this repository, so that half of the check has no meaning here.
 *
 * This script enforces the half that IS checkable from inside the repo:
 * the two governing documents exist and have not been structurally
 * mangled (wrong article count, missing identity statement).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const violations: string[] = [];

const constitutionPath = join(repoRoot, "CONSTITUTION.md");
if (!existsSync(constitutionPath)) {
  violations.push(`Missing governing document: ${constitutionPath}`);
} else {
  const constitution = readFileSync(constitutionPath, "utf8");
  const articles = constitution.match(/^## Article [IVX]+\b/gm) ?? [];
  if (articles.length !== 10) {
    violations.push(`CONSTITUTION.md must contain exactly 10 articles; found ${articles.length}`);
  }
}

const manifestoPath = join(repoRoot, "ZOUROBOROS.md");
if (!existsSync(manifestoPath)) {
  violations.push(`Missing governing document: ${manifestoPath}`);
} else {
  const manifesto = readFileSync(manifestoPath, "utf8");
  if (!/self[- ]evolving AI operating system/i.test(manifesto)) {
    violations.push("ZOUROBOROS.md is missing the canonical Zouroboros identity statement");
  }
}

if (violations.length > 0) {
  console.error("Governance document check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\nThese two files are governed by AGENTS.md and CONSTITUTION.md Article X. " +
      "If this change is an intentional amendment, it requires explicit human approval " +
      "(see Skills/zouroboros-governance/scripts/constitution-gate.ts, Article X: " +
      "X-AMENDMENT-AUTHORIZATION) — do not edit around this check.",
  );
  process.exit(2);
}

console.log("Governance document check passed: CONSTITUTION.md (10 articles), ZOUROBOROS.md (identity statement present).");
