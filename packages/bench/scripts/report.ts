#!/usr/bin/env bun
/**
 * Aggregate benchmark results into a unified markdown report.
 *
 * Usage:
 *   bun scripts/report.ts --runs data/runs/
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";
import { computeReplicateDistribution } from "./replicate-distribution";

interface BenchmarkRun {
  benchmark: string;
  timestamp: string;
  dataset: string;
  total_questions: number;
  scores: Record<string, any>;
  latency: {
    avg_retrieval_ms: number;
    avg_answer_ms: number;
    p95_retrieval_ms: number;
  };
  questions?: Array<{
    question_id?: string;
    correct?: boolean;
    truncated?: boolean;
    timed_out?: boolean;
  }>;
  replicate?: {
    seed?: string | number;
    cohort_id?: string;
    timeout_ms?: number;
    minimum_n?: number;
  };
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      runs: { type: "string", default: "data/runs" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: bun scripts/report.ts --runs <dir> [--output <file>]`);
    process.exit(0);
  }

  const runsDir = values.runs!;
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();

  if (files.length === 0) {
    console.log("No run files found in", runsDir);
    process.exit(1);
  }

  // P1-5: report a distribution over replicates, not a single best-of/mean
  // number. Default ON; byte-identical legacy output when explicitly disabled.
  const REPORT_REPLICATE_DIST =
    process.env.REPORT_REPLICATE_DIST !== "0" &&
    process.env.REPORT_REPLICATE_DIST !== "false";

  // Load most recent run per benchmark; also group ALL runs per benchmark so
  // the replicate distribution can be computed without disturbing the legacy
  // single-run tables (which still key off latestRuns).
  const latestRuns: Map<string, BenchmarkRun> = new Map();
  const allRuns: Map<string, BenchmarkRun[]> = new Map();
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(runsDir, file), "utf-8")) as BenchmarkRun;
      // Skip foreign-schema run files (e.g. the compression/correlation bench)
      // that share this dir but lack the BenchmarkRun shape — they would crash
      // the summary/detail tables that assume scores/latency exist.
      if (!data.benchmark || !data.scores || !data.latency) continue;
      const existing = latestRuns.get(data.benchmark);
      if (!existing || data.timestamp > existing.timestamp) {
        latestRuns.set(data.benchmark, data);
      }
      const group = allRuns.get(data.benchmark);
      if (group) group.push(data);
      else allRuns.set(data.benchmark, [data]);
    } catch {}
  }

  // Supermemory published baselines for comparison
  const supermemoryBaselines: Record<string, Record<string, number>> = {
    LongMemEval: {
      "overall": 81.6,
      "single-session-user": 97.14,
      "single-session-assistant": 96.43,
      "single-session-preference": 70.00,
      "knowledge-update": 88.46,
      "temporal-reasoning": 76.69,
      "multi-session": 71.43,
    },
    LoCoMo: {},
    ConvoMem: {},
  };

  // Build report
  const lines: string[] = [];
  const ts = new Date().toISOString().split("T")[0];

  lines.push(`# Zouroboros Benchmark Report`);
  lines.push(`> Generated: ${ts}`);
  lines.push(`> Engine: Zouroboros Memory System v4.0`);
  lines.push(`> Search: Hybrid (BM25 + Vector + Graph-Boost RRF)`);
  lines.push(``);

  // Overall summary table
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Benchmark | Questions | Accuracy | Avg Retrieval | P95 Retrieval | Avg Answer |`);
  lines.push(`|-----------|-----------|----------|---------------|---------------|------------|`);

  for (const [name, run] of latestRuns) {
    const accuracy = run.scores.overall_accuracy ?? run.scores.overall_f1 ?? "—";
    lines.push(
      `| ${name} | ${run.total_questions} | ${accuracy}% | ${run.latency.avg_retrieval_ms}ms | ${run.latency.p95_retrieval_ms}ms | ${run.latency.avg_answer_ms}ms |`
    );
  }
  lines.push(``);

  // Replicate Distribution — the reliability headline. Reports Solid (passed
  // in every run), Average, Best-of, and Ceiling (passed in any run) across N
  // replicates, so a single cherry-picked number can't masquerade as the score.
  if (REPORT_REPLICATE_DIST) {
    const pct = (v: number | undefined) => (v != null ? `${v}%` : "—");
    let truncatedTotal = 0;
    let timedOutTotal = 0;
    const distRows: string[] = [];
    const statusNotes: string[] = [];
    for (const [name, runs] of allRuns) {
      const cohortRuns = runs.filter((run) => run.replicate?.cohort_id);
      const latestCohort = cohortRuns
        .slice()
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
        ?.replicate?.cohort_id;
      const selectedRuns = latestCohort
        ? cohortRuns.filter((run) => run.replicate?.cohort_id === latestCohort)
        : runs;
      const minimumN = selectedRuns[0]?.replicate?.minimum_n;
      const d = computeReplicateDistribution(selectedRuns, { minimumN });
      truncatedTotal += d.truncatedCount;
      timedOutTotal += d.timedOutCount;
      const spread = d.spread != null ? d.spread.toFixed(1) : "—";
      const ci = d.avgAccuracyCi ? `${d.avgAccuracyCi.lower}–${d.avgAccuracyCi.upper}%` : "—";
      distRows.push(
        `| ${name} | ${d.status} | ${d.n}/${d.minimumN} | ${d.pairing.paired ? "yes" : "no"} | ${pct(d.solidPct)} | ${d.avgAccuracy}% | ${ci} | ${d.bestOf}% | ${pct(d.ceilingPct)} | ${spread} | ${d.truncatedCount} | ${d.timedOutCount} |`
      );
      if (d.status === "underpowered") statusNotes.push(`> **${name} is underpowered:** ${d.statusReasons.join("; ")}.`);
    }

    lines.push(`## Replicate Distribution`);
    lines.push(``);
    lines.push(`> Reported over the latest declared cohort per benchmark. **Publishable** requires unique paired seeds and the declared minimum N (default 5). The Average interval is a deterministic 95% bootstrap CI. **Solid** = passed in *every* run; **Ceiling** = passed in *any* run.`);
    lines.push(``);
    lines.push(`| Benchmark | Status | N/min | Paired seeds | Solid | Average | 95% CI | Best-of | Ceiling | Spread | Truncated | Timed Out |`);
    lines.push(`|-----------|--------|-------|--------------|-------|---------|--------|---------|---------|--------|-----------|-----------|`);
    lines.push(...distRows);
    lines.push(``);
    if (statusNotes.length > 0) {
      lines.push(...statusNotes);
      lines.push(``);
    }
    if (truncatedTotal > 0) {
      lines.push(`> ⚠ ${truncatedTotal} answer(s) hit the max_tokens cap (finish_reason=length) — scores may understate true accuracy. Re-run those at full limit before trusting the number.`);
      lines.push(``);
    }
    if (timedOutTotal > 0) {
      lines.push(`> ⚠ ${timedOutTotal} answer(s) hit the generation timeout — counted as failures, not silent skips.`);
      lines.push(``);
    }
  }

  // Per-benchmark details
  for (const [name, run] of latestRuns) {
    lines.push(`## ${name}`);
    lines.push(``);
    lines.push(`- **Dataset:** ${run.dataset}`);
    lines.push(`- **Questions:** ${run.total_questions}`);
    lines.push(`- **Run:** ${run.timestamp}`);
    lines.push(``);

    if (name === "LongMemEval" && run.scores.by_type) {
      lines.push(`### Accuracy by Question Type`);
      lines.push(``);
      lines.push(`| Type | Zouroboros | Supermemory | Δ |`);
      lines.push(`|------|-----------|-------------|---|`);

      const smBaseline = supermemoryBaselines.LongMemEval ?? {};
      for (const [type, data] of Object.entries(run.scores.by_type) as [string, any][]) {
        const sm = smBaseline[type];
        const delta = sm != null ? `${(data.accuracy - sm).toFixed(1)}` : "—";
        const smStr = sm != null ? `${sm}%` : "—";
        lines.push(`| ${type} | ${data.accuracy}% (${data.correct}/${data.total}) | ${smStr} | ${delta} |`);
      }

      const overallSm = smBaseline.overall;
      if (overallSm != null) {
        const delta = (run.scores.overall_accuracy - overallSm).toFixed(1);
        lines.push(`| **Overall** | **${run.scores.overall_accuracy}%** | **${overallSm}%** | **${delta}** |`);
      }
      lines.push(``);
    }

    if (name === "LoCoMo" && run.scores.by_category) {
      lines.push(`### Scores by Category`);
      lines.push(``);
      lines.push(`| Category | Avg F1 | Accuracy | Count |`);
      lines.push(`|----------|--------|----------|-------|`);
      for (const [cat, data] of Object.entries(run.scores.by_category) as [string, any][]) {
        lines.push(`| ${cat} | ${data.avg_f1} | ${data.accuracy}% | ${data.total} |`);
      }
      lines.push(``);
    }

    if (name === "ConvoMem" && run.scores.accuracy_matrix) {
      lines.push(`### Accuracy Matrix (Category × Context Size)`);
      lines.push(``);
      const allSizes = new Set<number>();
      for (const sizes of Object.values(run.scores.accuracy_matrix) as Record<number, number>[]) {
        for (const s of Object.keys(sizes)) allSizes.add(Number(s));
      }
      const sortedSizes = [...allSizes].sort((a, b) => a - b);

      lines.push(`| Category | ${sortedSizes.map((s) => `${s}`).join(" | ")} |`);
      lines.push(`|----------|${sortedSizes.map(() => "------").join("|")}|`);
      for (const [cat, sizes] of Object.entries(run.scores.accuracy_matrix) as [string, Record<number, number>][]) {
        const vals = sortedSizes.map((s) => sizes[s] != null ? `${sizes[s]}%` : "—");
        lines.push(`| ${cat} | ${vals.join(" | ")} |`);
      }
      lines.push(``);
    }

    if (name === "ZouroBench" && run.scores.by_category) {
      lines.push(`### Accuracy by Category`);
      lines.push(``);
      lines.push(`| Category | Accuracy | Correct | Total |`);
      lines.push(`|----------|----------|---------|-------|`);
      for (const [cat, data] of Object.entries(run.scores.by_category) as [string, any][]) {
        lines.push(`| ${cat} | ${data.accuracy}% | ${data.correct} | ${data.total} |`);
      }
      if (run.scores.overall_accuracy != null) {
        const totalCorrect = Object.values(run.scores.by_category as Record<string, any>).reduce((s: number, c: any) => s + c.correct, 0);
        const totalQ = Object.values(run.scores.by_category as Record<string, any>).reduce((s: number, c: any) => s + c.total, 0);
        lines.push(`| **Overall** | **${run.scores.overall_accuracy}%** | **${totalCorrect}** | **${totalQ}** |`);
      }
      lines.push(``);

      if (run.scores.by_type) {
        lines.push(`### Accuracy by Question Type`);
        lines.push(``);
        lines.push(`| Category : Type | Accuracy | Correct | Total |`);
        lines.push(`|-----------------|----------|---------|-------|`);
        for (const [type, data] of Object.entries(run.scores.by_type) as [string, any][]) {
          lines.push(`| ${type} | ${data.accuracy}% | ${data.correct} | ${data.total} |`);
        }
        lines.push(``);
      }
    }

    // Latency
    lines.push(`### Latency`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Avg Retrieval | ${run.latency.avg_retrieval_ms}ms |`);
    lines.push(`| P95 Retrieval | ${run.latency.p95_retrieval_ms}ms |`);
    lines.push(`| Avg Answer Gen | ${run.latency.avg_answer_ms}ms |`);
    lines.push(``);
  }

  // Methodology
  lines.push(`## Methodology`);
  lines.push(``);
  lines.push(`### Search Pipeline`);
  lines.push(`1. **Ingest:** Benchmark conversations stored as facts in temporary SQLite DB`);
  lines.push(`2. **Index:** text-embedding-3-small (1536-dim, OpenAI) embeddings generated for all facts`);
  lines.push(`3. **Retrieve:** Hybrid search (BM25 FTS5 + vector cosine + graph-boost RRF fusion)`);
  lines.push(`4. **Answer:** qwen2.5:7b generates answer from top-5 retrieved contexts`);
  lines.push(`5. **Judge:** GPT-4o binary judge (when --judge enabled) or heuristic F1 match`);
  lines.push(``);
  lines.push(`### System Under Test`);
  lines.push(`- **Engine:** Zouroboros Memory System v4.0`);
  lines.push(`- **Database:** SQLite (bun:sqlite) with FTS5 + WAL mode`);
  lines.push(`- **Embeddings:** text-embedding-3-small (1536-dim, OpenAI)`);
  lines.push(`- **Search:** RRF fusion (BM25: 0.60, Graph: 0.15, Freshness: 0.15, Confidence: 0.10)`);
  lines.push(`- **Answer Model:** qwen2.5:7b (local Ollama)`);
  lines.push(`- **No cloud dependencies** for retrieval (Ollama-only pipeline)`);
  lines.push(``);
  lines.push(`### Comparison Notes`);
  lines.push(`- Supermemory uses cloud-hosted infrastructure with proprietary indexing`);
  lines.push(`- Zouroboros runs entirely on local hardware (single-node Ollama)`);
  lines.push(`- Supermemory's LongMemEval scores are from their published research page`);
  lines.push(`- Direct comparison is informative but not apples-to-apples (different compute budgets)`);
  lines.push(``);

  const report = lines.join("\n");
  const outFile = values.output ?? join(runsDir, `REPORT-${ts}.md`);
  writeFileSync(outFile, report);
  console.log(`[report] Written to ${outFile}`);
  console.log(`[report] ${latestRuns.size} benchmarks included`);
}

main();
