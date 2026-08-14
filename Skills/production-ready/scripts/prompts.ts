#!/usr/bin/env bun
/**
 * prompts.ts — Regenerate the remediation prompt pack from an existing audit.
 *
 *   bun prompts.ts --audit /path/to/findings.json [--out DIR] [--min-severity LEVEL]
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AuditReport, Severity } from "./lib/types.ts";
import { buildPromptPack } from "./lib/prompts.ts";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      audit: { type: "string" },
      out: { type: "string" },
      "min-severity": { type: "string", default: "high" },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help || !values.audit) {
    console.log(`
prompts.ts — generate remediation prompts from an audit

Usage:
  bun prompts.ts --audit findings.json [--out prompts/] [--min-severity high]

Options:
  --audit FILE          Path to findings.json
  --out DIR             Output directory (default: <audit-dir>/prompts/)
  --min-severity LEVEL  critical | high | medium | low | info (default: high)
`);
    process.exit(0);
  }

  const auditPath = resolve(values.audit as string);
  const report = JSON.parse(readFileSync(auditPath, "utf8")) as AuditReport;
  const outDir = resolve((values.out as string) ?? join(auditPath, "..", "prompts"));
  const minSeverity = (values["min-severity"] as Severity) ?? "high";

  const minRank = SEVERITY_ORDER[minSeverity];
  const findings = report.results.flatMap((r) => r.findings).filter((f) => SEVERITY_ORDER[f.severity] <= minRank);

  mkdirSync(outDir, { recursive: true });
  const pack = buildPromptPack(findings, report.meta.config.repoPath);
  for (const [name, body] of pack) {
    writeFileSync(join(outDir, name), body);
  }

  // Write a master index file
  const indexLines = [`# Remediation Prompts`, ``, `Generated from ${auditPath} — ${pack.size} prompt(s).`, ``];
  for (const f of findings) {
    indexLines.push(`- **${f.severity}** — ${f.title} → \`${f.id.replace(/[^a-z0-9.-]/gi, "_")}.md\``);
  }
  writeFileSync(join(outDir, "INDEX.md"), indexLines.join("\n"));

  console.log(`Wrote ${pack.size} prompt(s) to ${outDir}`);
}

main();
