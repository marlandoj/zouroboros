#!/usr/bin/env bun
/**
 * audit.ts — Main orchestrator for the production-ready skill.
 *
 *   bun audit.ts --repo PATH --url URL [--out DIR] [--format json|md|html|all]
 *                [--only DOMAIN[,DOMAIN]] [--skip DOMAIN[,DOMAIN]]
 *                [--godmode] [--list] [--name NAME] [--purpose PURPOSE]
 *                [--has-user-data] [--has-uploads] [--has-admin] [--has-ai] [--has-payments]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { AuditConfig, AuditReport, CheckModule, Domain, Finding } from "./lib/types.ts";
import { detectStack, whichTool } from "./lib/runners.ts";
import { computeVerdict, VERDICT_EMOJI, VERDICT_LABEL } from "./lib/verdict.ts";
import { assessCoverage } from "./lib/coverage.ts";
import { loadPolicy, applyPolicy, mergePolicyIntoConfig, maxMediumThreshold } from "./lib/policy.ts";
import { renderMarkdown, renderHtml } from "./lib/report.ts";
import { buildPromptPack } from "./lib/prompts.ts";
import { triageFindings } from "./lib/triage.ts";

import { legalCheck } from "./checks/01-legal.ts";
import { secretsCheck } from "./checks/02-secrets.ts";
import { authenticationCheck } from "./checks/03-authentication.ts";
import { apiSafetyCheck } from "./checks/04-api-safety.ts";
import { owaspCheck } from "./checks/05-owasp.ts";
import { abuseRateCheck } from "./checks/06-abuse-rate.ts";
import { frontendCheck } from "./checks/07-frontend.ts";
import { loggingCheck } from "./checks/08-logging.ts";
import { accessibilityCheck } from "./checks/09-accessibility.ts";
import { performanceCheck } from "./checks/10-performance.ts";
import { paymentsCheck } from "./checks/11-payments.ts";
import { fileUploadsCheck } from "./checks/12-file-uploads.ts";
import { databaseCheck } from "./checks/13-database.ts";
import { aiCodeCheck } from "./checks/14-ai-code.ts";
import { browserTestCheck } from "./checks/15-browser-test.ts";
import { concurrencyCheck } from "./checks/16-concurrency.ts";
import { visualConsistencyCheck } from "./checks/17-visual-consistency.ts";
import { seoAeoCheck } from "./checks/18-seo-aeo.ts";

const ALL_CHECKS: CheckModule[] = [
  legalCheck,
  secretsCheck,
  authenticationCheck,
  apiSafetyCheck,
  owaspCheck,
  abuseRateCheck,
  frontendCheck,
  loggingCheck,
  accessibilityCheck,
  performanceCheck,
  paymentsCheck,
  fileUploadsCheck,
  databaseCheck,
  aiCodeCheck,
  browserTestCheck,
  concurrencyCheck,
  visualConsistencyCheck,
  seoAeoCheck,
];

const AUDIT_VERSION = "1.0.0";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      url: { type: "string" },
      out: { type: "string", default: "./production-ready-audit" },
      format: { type: "string", default: "all" },
      only: { type: "string" },
      skip: { type: "string" },
      config: { type: "string" },
      "manual-verified": { type: "boolean", default: false },
      godmode: { type: "boolean", default: false },
      triage: { type: "boolean", default: false },
      consensus: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      name: { type: "string" },
      purpose: { type: "string" },
      "has-user-data": { type: "boolean", default: false },
      "has-uploads": { type: "boolean", default: false },
      "has-admin": { type: "boolean", default: false },
      "has-ai": { type: "boolean", default: false },
      "has-payments": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.list) {
    console.log("Audit domains:");
    for (const c of ALL_CHECKS) {
      console.log(`  ${c.domain.padEnd(20)} ${c.description}`);
    }
    process.exit(0);
  }

  if (!values.repo && !values.url) {
    console.error("Error: at least one of --repo or --url is required.");
    console.error("Run with --help for usage.");
    process.exit(10);
  }

  const config: AuditConfig = {
    repoPath: values.repo ? resolve(String(values.repo)) : undefined,
    url: typeof values.url === "string" ? values.url : undefined,
    outDir: resolve(String(values.out)),
    format: (String(values.format) as any) ?? "all",
    appName: typeof values.name === "string" ? values.name : undefined,
    appPurpose: typeof values.purpose === "string" ? values.purpose : undefined,
    surfaces: {
      userData: values["has-user-data"] as boolean,
      uploads: values["has-uploads"] as boolean,
      admin: values["has-admin"] as boolean,
      ai: values["has-ai"] as boolean,
      payments: values["has-payments"] as boolean,
    },
    godmode: values.godmode as boolean,
    manualVerified: values["manual-verified"] as boolean,
  };

  if (values.only) config.only = String(values.only).split(",").map((s) => s.trim()) as Domain[];
  if (values.skip) config.skip = String(values.skip).split(",").map((s) => s.trim()) as Domain[];

  // Load declarative policy: explicit --config, else auto-discover
  // audit.config.json in the repo root (standard config-file behavior).
  let policyPath: string | undefined;
  if (values.config) {
    policyPath = resolve(String(values.config));
  } else if (config.repoPath) {
    const discovered = join(config.repoPath, "audit.config.json");
    if (existsSync(discovered)) policyPath = discovered;
  }
  if (policyPath) {
    try {
      config.policy = loadPolicy(policyPath);
      mergePolicyIntoConfig(config, config.policy);
    } catch (err) {
      console.error(`Error: could not load config ${policyPath}: ${(err as Error).message}`);
      process.exit(10);
    }
  }

  // Auto-detect stack and deployment if repo provided
  if (config.repoPath) {
    if (!existsSync(config.repoPath)) {
      console.error(`Error: repo path not found: ${config.repoPath}`);
      process.exit(10);
    }
    const stack = detectStack(config.repoPath);
    config.techStack = stack.stack;
    config.deployment = stack.deployment ?? undefined;
  }

  mkdirSync(config.outDir, { recursive: true });
  console.error(`📋 production-ready audit ${AUDIT_VERSION}`);
  console.error(`   repo:  ${config.repoPath ?? "—"}`);
  console.error(`   url:   ${config.url ?? "—"}`);
  console.error(`   out:   ${config.outDir}`);
  if (config.techStack?.length) console.error(`   stack: ${config.techStack.join(", ")}${config.deployment ? ` (deploy: ${config.deployment})` : ""}`);
  if (config.godmode) console.error(`   mode:  godmode 🦾`);
  console.error("");

  // Filter checks
  let checks = ALL_CHECKS;
  if (config.only && config.only.length) checks = checks.filter((c) => config.only!.includes(c.domain));
  if (config.skip && config.skip.length) checks = checks.filter((c) => !config.skip!.includes(c.domain));

  const startedAt = Date.now();
  const results = [];
  for (const check of checks) {
    process.stderr.write(`▸ ${check.domain.padEnd(20)} `);
    try {
      const result = await check.run(config);
      results.push(result);
      const counts = countSeverity(result.findings);
      const summary = counts.critical || counts.high || counts.medium
        ? `🔴${counts.critical} 🟠${counts.high} 🟡${counts.medium} 🔵${counts.low}`
        : "✅ clean";
      process.stderr.write(`${summary} (${(result.durationMs / 1000).toFixed(1)}s)\n`);
    } catch (err) {
      process.stderr.write(`❌ ${(err as Error).message}\n`);
      results.push({
        domain: check.domain,
        ranAt: new Date().toISOString(),
        durationMs: 0,
        toolsUsed: [],
        toolsMissing: [],
        findings: [],
        manualChecklist: [],
        error: (err as Error).message,
      });
    }
  }

  // ── Policy layer (optional --config) ─────────────────────
  if (config.policy) {
    for (const r of results) r.findings = applyPolicy(r.findings, config.policy);
  }

  let allFindings: Finding[] = results.flatMap((r) => r.findings);

  // ── Triage layer (optional) ──────────────────────────────
  const triageMode = (values.triage as boolean) || config.godmode;
  const consensusMode = values.consensus as boolean;
  let triageStats: any = null;
  if (triageMode) {
    process.stderr.write(`\n▸ triage             `);
    const t0 = Date.now();
    const tri = await triageFindings(allFindings, {
      consensus: consensusMode,
      repoPath: config.repoPath,
    });
    triageStats = tri.stats;
    const summary = `kept ${tri.stats.kept} · drop ${tri.stats.dropped} · downgrade ${tri.stats.downgraded}${consensusMode ? ` · llm ${tri.stats.consensusCalls}` : ""}`;
    process.stderr.write(`${summary} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
    // Replace findings within results with triage-kept set
    const keptIds = new Set(tri.kept.map((f) => f.id));
    for (const r of results) {
      r.findings = r.findings
        .filter((f) => keptIds.has(f.id))
        .map((f) => tri.kept.find((k) => k.id === f.id) ?? f);
    }
    // Persist suppressed findings for audit trail
    writeFileSync(join(config.outDir, "triage-dropped.json"), JSON.stringify(tri.dropped, null, 2));
    allFindings = results.flatMap((r) => r.findings);
  }

  const tooling = collectTooling();
  const coverage = assessCoverage({ results, tooling, config });
  const verdictResult = computeVerdict(allFindings, coverage, {
    maxMedium: maxMediumThreshold(config.policy),
  });

  const report: AuditReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      auditVersion: AUDIT_VERSION,
      config,
      durationMs: Date.now() - startedAt,
    },
    verdict: verdictResult.verdict,
    verdictReason: verdictResult.reason,
    scores: verdictResult.scores,
    hardBlockers: verdictResult.hardBlockers,
    results,
    manualChecklist: results.flatMap((r) => r.manualChecklist.map((m) => ({ domain: r.domain, ...m }))),
    tooling,
    coverage,
  };

  // Write outputs
  const fmt = config.format;
  if (fmt === "json" || fmt === "all") {
    writeFileSync(join(config.outDir, "findings.json"), JSON.stringify(report, null, 2));
  }
  if (fmt === "md" || fmt === "all") {
    writeFileSync(join(config.outDir, "report.md"), renderMarkdown(report));
  }
  if (fmt === "html" || fmt === "all") {
    writeFileSync(join(config.outDir, "report.html"), renderHtml(report));
  }

  writeFileSync(
    join(config.outDir, "verdict.json"),
    JSON.stringify(
      {
        verdict: verdictResult.verdict,
        label: VERDICT_LABEL[verdictResult.verdict],
        emoji: VERDICT_EMOJI[verdictResult.verdict],
        reason: verdictResult.reason,
        scores: verdictResult.scores,
        hardBlockerIds: verdictResult.hardBlockers.map((f) => f.id),
        findingsVerdict: verdictResult.findingsVerdict,
        coverageCeiling: verdictResult.coverageCeiling,
        cappedByCoverage: verdictResult.cappedByCoverage,
        coverage: {
          incomplete: coverage.incomplete,
          missingScanners: coverage.missingScanners,
          gaps: coverage.gaps,
        },
      },
      null,
      2,
    ),
  );

  // Prompts pack
  const promptThreshold = config.godmode ? ["critical", "high", "medium", "low", "info"] : ["critical", "high"];
  const promptCandidates = allFindings.filter((f) => promptThreshold.includes(f.severity));
  if (promptCandidates.length > 0) {
    const pack = buildPromptPack(promptCandidates, config.repoPath);
    const promptsDir = join(config.outDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    for (const [name, body] of pack) {
      writeFileSync(join(promptsDir, name), body);
    }
  }

  // LAUNCH_CHECKLIST.md in repo (godmode)
  if (config.godmode && config.repoPath) {
    const checklistPath = join(config.repoPath, "LAUNCH_CHECKLIST.md");
    writeFileSync(checklistPath, generateLaunchChecklist(report));
    console.error(`\n📄 Wrote launch checklist → ${checklistPath}`);
  }

  console.error("");
  console.error(`${VERDICT_EMOJI[verdictResult.verdict]}  Verdict: ${VERDICT_LABEL[verdictResult.verdict]}`);
  console.error(`    ${verdictResult.reason}`);
  console.error("");
  console.error(`📊  ${verdictResult.scores.critical} critical · ${verdictResult.scores.high} high · ${verdictResult.scores.medium} medium · ${verdictResult.scores.low} low`);
  if (coverage.incomplete) {
    console.error(`🔍  Coverage incomplete — capped at ${VERDICT_LABEL[coverage.ceiling]} (findings alone: ${VERDICT_LABEL[verdictResult.findingsVerdict]})`);
    for (const g of coverage.gaps.slice(0, 6)) {
      console.error(`      ${g.severity === "blocking" ? "🚧" : "•"} ${g.detail}`);
    }
  }
  console.error(`📂  Reports written to ${config.outDir}`);
  if (promptCandidates.length > 0) {
    console.error(`📨  ${promptCandidates.length} remediation prompt(s) in ${config.outDir}/prompts/`);
  }

  if (config.godmode && (process.platform === "darwin" || process.platform === "linux")) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const htmlPath = join(config.outDir, "report.html");
    if (existsSync(htmlPath)) {
      try {
        const { spawn } = await import("node:child_process");
        spawn(opener, [htmlPath], { detached: true, stdio: "ignore" }).unref();
      } catch {}
    }
  }

  process.exit(verdictResult.exitCode);
}

function countSeverity(findings: Finding[]) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function collectTooling(): AuditReport["tooling"] {
  const tools = ["gitleaks", "trufflehog", "semgrep", "osv-scanner", "trivy", "lighthouse", "axe", "pa11y", "nuclei"];
  const out: AuditReport["tooling"] = {};
  for (const t of tools) {
    const s = whichTool(t);
    out[t] = { available: s.available, path: s.path, version: s.version };
  }
  return out;
}

function generateLaunchChecklist(r: AuditReport): string {
  const L: string[] = [];
  L.push(`# Launch Checklist`);
  L.push(``);
  L.push(`Generated by \`production-ready\` ${AUDIT_VERSION} on ${r.meta.generatedAt}`);
  L.push(``);
  L.push(`**Verdict:** ${VERDICT_EMOJI[r.verdict]} ${VERDICT_LABEL[r.verdict]}`);
  L.push(``);
  L.push(`## Hard blockers`);
  L.push(``);
  if (r.hardBlockers.length === 0) {
    L.push(`- [x] No hard blockers`);
  } else {
    for (const f of r.hardBlockers) {
      L.push(`- [ ] **${f.title}** — \`${f.id}\` (${f.domain})`);
    }
  }
  L.push(``);
  L.push(`## Manual sign-offs`);
  L.push(``);
  for (const m of r.manualChecklist) {
    L.push(`- [ ] *${m.domain}* — ${m.item}`);
  }
  L.push(``);
  L.push(`---`);
  L.push(``);
  L.push(`> Re-run \`bun /home/workspace/Skills/production-ready/scripts/audit.ts --repo . --url <URL>\` before launch and ensure verdict is **Launch-Ready** or **Launch with Monitoring**.`);
  return L.join("\n");
}

function printHelp() {
  console.log(`
production-ready — Launch readiness audit

Usage:
  bun audit.ts --repo PATH [--url URL] [options]
  bun audit.ts --url URL [options]
  bun audit.ts --list                   # list all domains

Options:
  --repo PATH           Local repo to scan
  --url URL             Deployed URL for DAST / Lighthouse / a11y / browser scenarios
  --out DIR             Output directory (default: ./production-ready-audit)
  --format FMT          json | md | html | all  (default: all)
  --only DOMAIN[,...]   Run only these domains
  --skip DOMAIN[,...]   Skip these domains
  --config PATH         Load an audit.config.json policy (auto-discovered in the repo root if omitted; see references/audit-config-schema.md)
  --manual-verified     Assert a human has signed off the critical manual checks
                        (required to reach Launch-Ready)
  --godmode             Aggressive heuristics + prompt every finding + open report
  --triage              Reproduce-the-finding pass: drops obvious heuristic FPs
                        (matches in comments, regex literals, rule definitions)
  --consensus           With --triage, adjudicate surviving heuristic findings
                        via OpenAI + Anthropic vote (requires API keys in env).
                        Disagreement → downgrade one tier + flag for review.
  --name NAME           App name (shown in report header)
  --purpose TEXT        One-line app purpose
  --has-user-data       Hint: app stores user data (enables stricter legal checks)
  --has-uploads         Hint: app accepts file uploads
  --has-admin           Hint: app has admin routes
  --has-ai              Hint: app calls LLM/AI APIs
  --has-payments        Hint: app processes payments
  --help                Show this help

Exit codes:
   0  launch-ready
   1  launch-with-monitoring
   2  private-beta-only
   3  do-not-launch
  10  audit error
`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(10);
});
