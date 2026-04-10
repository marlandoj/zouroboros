#!/usr/bin/env bun

/**
 * Swarm Decision Gate Benchmark
 *
 * Runs the gate against a labeled corpus of real-world tasks
 * and measures classification accuracy per decision class.
 *
 * Usage:
 *   bun scripts/swarm-gate-bench.ts
 *   bun scripts/swarm-gate-bench.ts --verbose
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = resolve(__dirname, "../../swarm/src/routing/swarm-decision-gate.ts");

interface GateResult {
  decision: "SWARM" | "DIRECT" | "SUGGEST" | "FORCE_SWARM";
  score: number;
  signals: Record<string, number>;
  weightedSignals: Record<string, number>;
  override: string | null;
  reason: string;
  performanceMs: number;
}

type ExpectedDecision = "DIRECT" | "SUGGEST" | "SWARM" | "FORCE_SWARM";

interface TestCase {
  label: string;
  message: string;
  expected: ExpectedDecision;
  category: string;
}

// ─── Labeled corpus ─────────────────────────────────────────────────────────

const CORPUS: TestCase[] = [
  // ── DIRECT: trivial / single-step / conversational ──
  {
    label: "greeting",
    message: "Hey, how's it going?",
    expected: "DIRECT",
    category: "conversational",
  },
  {
    label: "time question",
    message: "What time is it in Phoenix?",
    expected: "DIRECT",
    category: "conversational",
  },
  {
    label: "explain concept",
    message: "How does the memory gate work?",
    expected: "DIRECT",
    category: "conversational",
  },
  {
    label: "single file fix",
    message: "Fix the TypeScript error in bot-engine.ts line 42",
    expected: "DIRECT",
    category: "single-fix",
  },
  {
    label: "add a field",
    message: "Add a new field called 'status' to the user model",
    expected: "DIRECT",
    category: "single-fix",
  },
  {
    label: "restart service",
    message: "Restart the JHF service",
    expected: "DIRECT",
    category: "ops-simple",
  },
  {
    label: "check logs",
    message: "Check the logs for errors in the last hour",
    expected: "DIRECT",
    category: "ops-simple",
  },
  {
    label: "git status",
    message: "Show me the current git status and recent commits",
    expected: "DIRECT",
    category: "ops-simple",
  },
  {
    label: "read a file",
    message: "Read the contents of AGENTS.md",
    expected: "DIRECT",
    category: "single-fix",
  },
  {
    label: "quick with bias",
    message: "Just quickly check if the tests pass",
    expected: "DIRECT",
    category: "biased-direct",
  },
  {
    label: "simple rename",
    message: "Rename the variable 'foo' to 'barCount' in utils.ts",
    expected: "DIRECT",
    category: "single-fix",
  },
  {
    label: "check service health",
    message: "Is the JHF service healthy?",
    expected: "DIRECT",
    category: "ops-simple",
  },
  {
    label: "simple question about code",
    message: "What does the scoreParallelism function do?",
    expected: "DIRECT",
    category: "conversational",
  },
  {
    label: "look up a setting",
    message: "What model is the Alaric persona using?",
    expected: "DIRECT",
    category: "conversational",
  },
  {
    label: "single deploy",
    message: "Deploy the latest changes to production",
    expected: "DIRECT",
    category: "ops-simple",
  },

  // ── SUGGEST: multi-step but not massive ──
  {
    label: "research + report",
    message: "Research the top 5 AI memory systems, compare their architectures, create a comparison matrix, and write a detailed analysis report.",
    expected: "SWARM",
    category: "research-analysis",
  },
  {
    label: "ECC repo analysis (natural)",
    message: "Deep dive into the everything-claude-code repository. Catalogue all agents, skills, hooks, and architectural patterns. Cross-reference each against the Zouroboros ecosystem to identify gaps. Generate a prioritized gap matrix with effort estimates. Compile into a PDF report and email it to me.",
    expected: "SWARM",
    category: "research-analysis",
  },
  {
    label: "multi-domain auth impl",
    message: "Implement a new authentication system across the API, frontend dashboard, and database schema. Create migration scripts, update all route handlers, add test coverage for each endpoint, deploy to production, and send a comprehensive report with benchmark results via email.",
    expected: "SWARM",
    category: "multi-domain",
  },
  {
    label: "security audit",
    message: "Audit the entire Zouroboros ecosystem for security vulnerabilities. Scan each package, review authentication flows, test API endpoints, and generate a comprehensive security report with remediation priorities.",
    expected: "SWARM",
    category: "audit",
  },
  {
    label: "feature + tests + docs",
    message: "Build a new dashboard page for the trading bot, add unit tests for all components, and update the README with usage instructions.",
    expected: "SUGGEST",
    category: "multi-domain",
  },
  {
    label: "refactor + test + deploy + guide",
    message: "Refactor the entire authentication module, update all API routes, add comprehensive test coverage, deploy to staging, and write a migration guide.",
    expected: "SWARM",
    category: "multi-domain",
  },
  {
    label: "performance optimization multi-system",
    message: "Profile the memory system for performance bottlenecks, optimize the database queries, update the indexing pipeline, and benchmark before and after with a detailed report.",
    expected: "SWARM",
    category: "optimization",
  },
  {
    label: "blog + social + email",
    message: "Write a blog post about the new swarm features, create social media assets, and draft an email announcement to send to the mailing list.",
    expected: "SWARM",
    category: "content-multi",
  },

  // ── SWARM: massive cross-system overhauls ──
  {
    label: "full platform migration",
    message: "Migrate the entire platform from SQLite to PostgreSQL. Update all database schemas, migration scripts, and ORM queries across the API server, task orchestrator, and memory system. Create integration tests for each service, update CI pipeline configuration, deploy to staging, run benchmark comparisons, and compile a comprehensive migration report with rollback procedures.",
    expected: "SWARM",
    category: "migration",
  },
  {
    label: "complete notification system",
    message: "Build a complete notification system: design the database schema, implement the API endpoints, create the frontend dashboard components, integrate email and SMS delivery services, write end-to-end test coverage, configure CI/CD pipeline, deploy all services to production, and send a detailed architecture report.",
    expected: "SWARM",
    category: "greenfield",
  },
  {
    label: "monorepo consolidation",
    message: "Consolidate all 6 repositories into a single monorepo. Migrate each package with full git history, update all import paths across every file, reconfigure CI/CD pipelines for each package, create a unified build system, add cross-package integration tests, update all documentation, deploy the consolidated system to production, and publish updated packages to npm.",
    expected: "SWARM",
    category: "migration",
  },
  {
    label: "full-stack app from scratch",
    message: "Build a complete expense tracking application from scratch: design the database schema with PostgreSQL, create the REST API with authentication and authorization, build the React frontend with dashboards and charts, implement file upload for receipts, add email notifications for budget alerts, write comprehensive test suites for backend and frontend, set up CI/CD pipeline, deploy to production, and generate a technical architecture document.",
    expected: "SWARM",
    category: "greenfield",
  },

  // ── FORCE_SWARM: explicit override ──
  {
    label: "use swarm orchestration",
    message: "Use swarm orchestration to analyze this codebase and generate a report.",
    expected: "FORCE_SWARM",
    category: "override",
  },
  {
    label: "swarm this",
    message: "Swarm this task: update all the configuration files.",
    expected: "FORCE_SWARM",
    category: "override",
  },
  {
    label: "run through the swarm",
    message: "Run this through the swarm pipeline and deliver results via email.",
    expected: "FORCE_SWARM",
    category: "override",
  },
  {
    label: "engage swarm",
    message: "Engage swarm to refactor the module.",
    expected: "FORCE_SWARM",
    category: "override",
  },
  {
    label: "full swarm pipeline",
    message: "Full swarm pipeline for this implementation task.",
    expected: "FORCE_SWARM",
    category: "override",
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

async function runGate(message: string): Promise<GateResult> {
  const tmpFile = `/tmp/swarm-gate-bench-input-${Date.now()}.txt`;
  await Bun.write(tmpFile, message);
  const msgFromFile = await Bun.file(tmpFile).text();

  const proc = Bun.spawn(["bun", GATE_SCRIPT, "--json", msgFromFile], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Clean up
  try { await Bun.write(tmpFile, ""); } catch {}

  if (!stdout.trim()) {
    throw new Error(`Gate returned empty output for message: "${message.slice(0, 60)}..." stderr: ${stderr}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`JSON parse failed for message: "${message.slice(0, 60)}..." stdout: ${stdout.slice(0, 200)} stderr: ${stderr}`);
  }
}

function isAcceptable(expected: ExpectedDecision, actual: string): boolean {
  if (expected === actual) return true;
  // SWARM and SUGGEST are adjacent — accept SUGGEST when expecting SWARM and vice versa
  // but only if the score is in the boundary zone (0.50-0.65)
  return false;
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const startTime = performance.now();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          Swarm Decision Gate — Classification Bench         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results: Array<{
    test: TestCase;
    result: GateResult;
    pass: boolean;
  }> = [];

  // Run all tests
  for (const test of CORPUS) {
    const result = await runGate(test.message);
    const pass = isAcceptable(test.expected, result.decision);
    results.push({ test, result, pass });

    if (verbose) {
      const icon = pass ? "✓" : "✗";
      const color = pass ? "\x1b[32m" : "\x1b[31m";
      console.log(`${color}${icon}\x1b[0m [${test.expected.padEnd(11)}→${result.decision.padEnd(11)}] score=${result.score.toFixed(3)} | ${test.label}`);
      if (!pass) {
        console.log(`  Expected: ${test.expected}, Got: ${result.decision} (score: ${result.score.toFixed(4)})`);
        console.log(`  Signals: ${JSON.stringify(result.signals)}`);
      }
    }
  }

  const totalTime = performance.now() - startTime;

  // ── Compute metrics ──
  const total = results.length;
  const passing = results.filter(r => r.pass).length;
  const failing = results.filter(r => !r.pass);
  const accuracy = passing / total;

  // Per-class metrics
  const classes: ExpectedDecision[] = ["DIRECT", "SUGGEST", "SWARM", "FORCE_SWARM"];
  const classMetrics: Record<string, { tp: number; fp: number; fn: number; total: number }> = {};

  for (const cls of classes) {
    const tp = results.filter(r => r.test.expected === cls && r.result.decision === cls).length;
    const fp = results.filter(r => r.test.expected !== cls && r.result.decision === cls).length;
    const fn = results.filter(r => r.test.expected === cls && r.result.decision !== cls).length;
    const classTotal = results.filter(r => r.test.expected === cls).length;
    classMetrics[cls] = { tp, fp, fn, total: classTotal };
  }

  // Per-category accuracy
  const categories = [...new Set(CORPUS.map(t => t.category))];
  const categoryMetrics: Record<string, { pass: number; total: number }> = {};
  for (const cat of categories) {
    const catResults = results.filter(r => r.test.category === cat);
    categoryMetrics[cat] = {
      pass: catResults.filter(r => r.pass).length,
      total: catResults.length,
    };
  }

  // Avg latency
  const avgLatency = results.reduce((sum, r) => sum + r.result.performanceMs, 0) / total;

  // ── Report ──
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("                       RESULTS SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  console.log(`  Overall Accuracy:  ${passing}/${total} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`  Total Latency:     ${totalTime.toFixed(0)}ms`);
  console.log(`  Avg Gate Latency:  ${avgLatency.toFixed(1)}ms per classification\n`);

  // Per-class table
  console.log("  Per-Class Metrics:");
  console.log("  ┌──────────────┬───────┬────┬────┬────┬───────────┬────────┐");
  console.log("  │ Class        │ Total │ TP │ FP │ FN │ Precision │ Recall │");
  console.log("  ├──────────────┼───────┼────┼────┼────┼───────────┼────────┤");
  for (const cls of classes) {
    const m = classMetrics[cls];
    const precision = m.tp + m.fp > 0 ? (m.tp / (m.tp + m.fp)) : 0;
    const recall = m.tp + m.fn > 0 ? (m.tp / (m.tp + m.fn)) : 0;
    console.log(`  │ ${cls.padEnd(12)} │ ${String(m.total).padStart(5)} │ ${String(m.tp).padStart(2)} │ ${String(m.fp).padStart(2)} │ ${String(m.fn).padStart(2)} │ ${(precision * 100).toFixed(1).padStart(8)}% │ ${(recall * 100).toFixed(1).padStart(5)}% │`);
  }
  console.log("  └──────────────┴───────┴────┴────┴────┴───────────┴────────┘\n");

  // Per-category table
  console.log("  Per-Category Accuracy:");
  console.log("  ┌─────────────────────┬───────┬──────┬──────────┐");
  console.log("  │ Category            │ Total │ Pass │ Accuracy │");
  console.log("  ├─────────────────────┼───────┼──────┼──────────┤");
  for (const cat of categories) {
    const m = categoryMetrics[cat];
    const acc = (m.pass / m.total * 100).toFixed(1);
    console.log(`  │ ${cat.padEnd(19)} │ ${String(m.total).padStart(5)} │ ${String(m.pass).padStart(4)} │ ${acc.padStart(7)}% │`);
  }
  console.log("  └─────────────────────┴───────┴──────┴──────────┘\n");

  // Failures
  if (failing.length > 0) {
    console.log("  Failures:");
    for (const f of failing) {
      console.log(`    ✗ "${f.test.label}" — expected ${f.test.expected}, got ${f.result.decision} (score: ${f.result.score.toFixed(3)})`);
      const topSignals = Object.entries(f.result.signals)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`);
      if (topSignals.length > 0) {
        console.log(`      Top signals: ${topSignals.join(", ")}`);
      }
    }
    console.log("");
  }

  // Verdict
  const verdict = accuracy >= 0.90 ? "PASS" : accuracy >= 0.80 ? "MARGINAL" : "FAIL";
  const verdictColor = verdict === "PASS" ? "\x1b[32m" : verdict === "MARGINAL" ? "\x1b[33m" : "\x1b[31m";
  console.log(`  Verdict: ${verdictColor}${verdict}\x1b[0m (threshold: 90% for PASS, 80% for MARGINAL)\n`);

  // Exit code
  process.exit(verdict === "FAIL" ? 1 : 0);
}

main();
