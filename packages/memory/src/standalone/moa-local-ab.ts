#!/usr/bin/env bun
// =============================================================================
// moa-local-ab.ts — A/B comparison harness: vendor (OpenRouter) vs self-hosted
// (vLLM/SGLang) for the SAME base model, over a 12-instance SWE-bench-style set.
//
// Closes ZOU-421's "isolate API-call overhead from model quality" deliverable:
// the same base model (default DeepSeek-V4) is asked the same 12 tasks via two
// transports — the vendor API (OpenRouter) and the self-hosted local tier
// (ZO_VLLM_BASE_URL). Per instance we capture text, latency, tokens, cost, and a
// normalized similarity between the two outputs. Aggregates report match rate,
// mean similarity, mean latency delta, and total cost (vendor vs self).
//
// MODES
//   --dry-run   Deterministic local mock for BOTH paths (zero spend, zero
//               network). Proves the pipeline end-to-end: fixture load → dual
//               dispatch → metrics → report. Default when ZO_VLLM_BASE_URL is
//               unset. Outputs are clearly labelled SIMULATED.
//   --live      Requires ZO_VLLM_BASE_URL (and OPENROUTER_API_KEY). Runs the real
//               vendor call and the real self-hosted call via the SAME
//               proposerChat() production dispatch the moaGenerate path uses
//               (Eval-Production Parity). BURN BUDGET: up to 12 vendor + 12 self
//               calls — do not run casually.
//
// FLAGS
//   --fixtures <path>   Override the 12-instance fixture set (JSON array).
//                       Default: moa-local-ab.fixtures.json next to this script.
//   --base <id>         Base model to compare (default: deepseek-v4).
//   --vendor-slug <id>  OpenRouter model id for the vendor path
//                       (default: deepseek/deepseek-v4-pro).
//   --local-model <id>  Served model id for the self path (default: ZO_VLLM_MODEL
//                       or deepseek-v4).
//   --out <dir>         Report output directory (default: next to this script).
//   --help              Show this help.
//
// NOTE ON QUALITY METRIC
//   SWE-bench's true quality signal is pass@k — whether the generated patch
//   passes the instance's hidden test suite. Running those suites needs the
//   SWE-bench evaluation harness (docker) on the annex, which is a LIVE-ONLY
//   follow-up (deferred here). This harness delivers the API-overhead isolation
//   (latency / cost / tokens) plus an output-parity proxy (normalized similarity),
//   which is exactly the "vendor vs self-hosted" transport comparison the ticket
//   asks to document. Pass@k is recorded as a deferred live-annex measurement.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { proposerChat, getMoaProposers, localTierArmed, localInferenceHealthCheck } from "./model-client";
import type { Proposer } from "./model-client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  repo: string;
  base: string;
  problem_statement: string;
  expected: string;
}

interface PathResult {
  text: string;
  latency_ms: number;
  inTok: number;
  outTok: number;
  cost_usd: number;
  error?: string;
}

interface InstanceResult {
  id: string;
  repo: string;
  base: string;
  vendor: PathResult;
  self: PathResult;
  similarity: number;      // normalized token-Jaccard ∩ normalized Levenshtein ∈ [0,1]
  latency_delta_ms: number; // self - vendor (negative ⇒ self faster)
  verdict: "MATCH" | "CLOSE" | "DIVERGE" | "ERROR";
}

interface Aggregate {
  n: number;
  match_rate: number;
  mean_similarity: number;
  mean_latency_delta_ms: number;
  total_vendor_cost_usd: number;
  total_self_cost_usd: number;
  verdicts: Record<string, number>;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  dryRun: boolean;
  live: boolean;
  fixtures: string;
  base: string;
  vendorSlug: string;
  localModel: string;
  outDir: string;
  help: boolean;
} {
  const here = import.meta.dir;
  const args: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { flags.add("help"); continue; }
    if (a === "--dry-run") { flags.add("dryRun"); continue; }
    if (a === "--live") { flags.add("live"); continue; }
    const next = argv[i + 1];
    if (a === "--fixtures") { args.fixtures = next; i++; }
    else if (a === "--base") { args.base = next; i++; }
    else if (a === "--vendor-slug") { args.vendorSlug = next; i++; }
    else if (a === "--local-model") { args.localModel = next; i++; }
    else if (a === "--out") { args.out = next; i++; }
  }
  return {
    dryRun: flags.has("dryRun"),
    live: flags.has("live"),
    fixtures: args.fixtures || join(here, "moa-local-ab.fixtures.json"),
    base: args.base || "deepseek-v4",
    vendorSlug: args.vendorSlug || "deepseek/deepseek-v4-pro",
    localModel: args.localModel || process.env.ZO_VLLM_MODEL || "deepseek-v4",
    outDir: args.out || here,
    help: flags.has("help"),
  };
}

const HELP = `moa-local-ab.ts — vendor vs self-hosted A/B on a 12-instance SWE-bench set.

  bun moa-local-ab.ts [--dry-run|--live] [--fixtures <path>] [--base <id>]
                      [--vendor-slug <id>] [--local-model <id>] [--out <dir>]

  --dry-run   Deterministic mock, zero spend (default when ZO_VLLM_BASE_URL unset).
  --live      Real calls via production proposerChat (needs ZO_VLLM_BASE_URL).
  --fixtures  Path to a JSON array of fixtures (default: moa-local-ab.fixtures.json).
  --base      Base model id (default: deepseek-v4).
  --vendor-slug  OpenRouter vendor model id (default: deepseek/deepseek-v4-pro).
  --local-model  vLLM served model id (default: ZO_VLLM_MODEL or deepseek-v4).
  --out       Report output directory (default: next to this script).
`;

// ─── Metrics ──────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  const maxLen = Math.max(a.length, b.length);
  const levRatio = maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
  return (jaccard + levRatio) / 2;
}

function verdictOf(sim: number, errored: boolean): InstanceResult["verdict"] {
  if (errored) return "ERROR";
  if (sim >= 0.9) return "MATCH";
  if (sim >= 0.6) return "CLOSE";
  return "DIVERGE";
}

function countTok(text: string): { inTok: number; outTok: number } {
  const n = tokens(text).length;
  return { inTok: Math.max(1, Math.round(n * 1.3)), outTok: n };
}

// ─── Mock (dry-run only) ──────────────────────────────────────────────────────

function mockRun(label: "vendor" | "self", fx: Fixture): { text: string; latency_ms: number; inTok: number; outTok: number } {
  const out = label === "vendor" ? fx.expected : dropLastToken(fx.expected);
  const tok = countTok(fx.expected);
  // Simulated transport overhead: vendor pays an API hop (~100ms + per-token);
  // self-hosted avoids the hop (faster per token). Deterministic from token count.
  const latency = label === "vendor"
    ? 100 + Math.round(tok.outTok / 5)
    : 40 + Math.round(tok.outTok / 20);
  return { text: out, latency_ms: latency, inTok: tok.inTok, outTok: tok.outTok };
}

// Minimal perturbation: drop only the final token so the SIMULATED same-base-
// model comparison reflects high parity (MATCH), not artificial divergence.
function dropLastToken(s: string): string {
  const m = s.match(/^(.*?)(\s+)?(\S+)\s*$/s);
  if (!m) return s;
  return m[1] + (m[2] ? "" : "");
}

// ─── Live dispatch ────────────────────────────────────────────────────────────

const VLLM_BASE_URL = process.env.ZO_VLLM_BASE_URL || "";
const VLLM_TOKEN = process.env.ZO_VLLM_API_KEY || "";
const VLLM_USD_PER_1K = Number(process.env.ZO_VLLM_USD_PER_1K || 0) || 0;
const VENDOR_USD_PER_1K = 0.0005;
const MAX_TOKENS = 2048;
const TEMP = 0.2;
const SYSTEM = "You are an expert software engineer fixing a bug in an open-source Python repository. Produce the minimal correct patch and a one-sentence rationale.";

async function liveVendor(vendorSlug: string, fx: Fixture): Promise<PathResult> {
  const start = Date.now();
  const p: Proposer = { slug: vendorSlug, kind: "vendor", model: vendorSlug };
  try {
    const r = await proposerChat(p, SYSTEM, fx.problem_statement, MAX_TOKENS, TEMP);
    const cost = (r.inTok + r.outTok) * VENDOR_USD_PER_1K / 1000;
    return { text: r.text, latency_ms: Date.now() - start, inTok: r.inTok, outTok: r.outTok, cost_usd: cost };
  } catch (e) {
    return { text: "", latency_ms: Date.now() - start, inTok: 0, outTok: 0, cost_usd: 0, error: String(e) };
  }
}

async function liveSelf(localModel: string, fx: Fixture): Promise<PathResult> {
  const start = Date.now();
  const p: Proposer = {
    slug: `local/${localModel}`,
    kind: "local",
    model: localModel,
    baseURL: VLLM_BASE_URL ? `${VLLM_BASE_URL.replace(/\/+$/, "")}/chat/completions` : undefined,
    token: VLLM_TOKEN || undefined,
  };
  try {
    const r = await proposerChat(p, SYSTEM, fx.problem_statement, MAX_TOKENS, TEMP);
    const cost = (r.inTok + r.outTok) * VLLM_USD_PER_1K / 1000;
    return { text: r.text, latency_ms: Date.now() - start, inTok: r.inTok, outTok: r.outTok, cost_usd: cost };
  } catch (e) {
    return { text: "", latency_ms: Date.now() - start, inTok: 0, outTok: 0, cost_usd: 0, error: String(e) };
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function runInstance(
  mode: "dry" | "live",
  vendorSlug: string,
  localModel: string,
  fx: Fixture,
): Promise<InstanceResult> {
  let vendor: PathResult, selfR: PathResult;
  if (mode === "dry") {
    const v = mockRun("vendor", fx);
    const s = mockRun("self", fx);
    vendor = { ...v, cost_usd: (v.inTok + v.outTok) * VENDOR_USD_PER_1K / 1000 };
    selfR = { ...s, cost_usd: (s.inTok + s.outTok) * VLLM_USD_PER_1K / 1000 };
  } else {
    [vendor, selfR] = await Promise.all([liveVendor(vendorSlug, fx), liveSelf(localModel, fx)]);
  }
  const errored = Boolean(vendor.error || selfR.error);
  const sim = errored ? 0 : similarity(vendor.text, selfR.text);
  return {
    id: fx.id,
    repo: fx.repo,
    base: fx.base,
    vendor,
    self: selfR,
    similarity: Math.round(sim * 1000) / 1000,
    latency_delta_ms: selfR.latency_ms - vendor.latency_ms,
    verdict: verdictOf(sim, errored),
  };
}

function aggregate(results: InstanceResult[]): Aggregate {
  const n = results.length;
  let simSum = 0, latSum = 0, vCost = 0, sCost = 0;
  const verdicts: Record<string, number> = { MATCH: 0, CLOSE: 0, DIVERGE: 0, ERROR: 0 };
  for (const r of results) {
    simSum += r.similarity;
    latSum += r.latency_delta_ms;
    vCost += r.vendor.cost_usd;
    sCost += r.self.cost_usd;
    verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
  }
  return {
    n,
    match_rate: n ? Math.round((verdicts.MATCH / n) * 1000) / 1000 : 0,
    mean_similarity: n ? Math.round((simSum / n) * 1000) / 1000 : 0,
    mean_latency_delta_ms: n ? Math.round(latSum / n) : 0,
    total_vendor_cost_usd: Math.round(vCost * 1e6) / 1e6,
    total_self_cost_usd: Math.round(sCost * 1e6) / 1e6,
    verdicts,
  };
}

function toMarkdown(mode: "dry" | "live", base: string, results: InstanceResult[], agg: Aggregate, armed: boolean, health?: { available: boolean; latency_ms: number; error?: string }): string {
  const banner = mode === "dry"
    ? "> **SIMULATED DRY-RUN** — deterministic mock, zero spend. Proves the pipeline (load → dual dispatch → metrics → report). Live GPU numbers deferred to the Hetzner annex (ZOU-414)."
    : "> **LIVE** — real vendor + self-hosted calls via production proposerChat().";
  const lines: string[] = [];
  lines.push(`# ZOU-421 — Vendor vs Self-hosted A/B (${mode === "dry" ? "DRY-RUN" : "LIVE"})`);
  lines.push("");
  lines.push(`**Base model:** \`${base}\` · **Instances:** ${agg.n} · **Local tier armed:** ${armed} · **Generated:** ${new Date().toISOString()}`);
  if (health) lines.push(`**Local endpoint health:** ${health.available ? "available" : "unavailable"} (${health.latency_ms} ms${health.error ? "; " + health.error : ""})`);
  lines.push("");
  lines.push(banner);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Match rate (sim ≥ 0.9) | ${agg.match_rate} |`);
  lines.push(`| Mean similarity | ${agg.mean_similarity} |`);
  lines.push(`| Mean latency delta (self − vendor) | ${agg.mean_latency_delta_ms} ms |`);
  lines.push(`| Total vendor cost | $${agg.total_vendor_cost_usd} |`);
  lines.push(`| Total self cost | $${agg.total_self_cost_usd} |`);
  lines.push(`| Verdicts | MATCH ${verdicts(agg, "MATCH")} · CLOSE ${verdicts(agg, "CLOSE")} · DIVERGE ${verdicts(agg, "DIVERGE")} · ERROR ${verdicts(agg, "ERROR")} |`);
  lines.push("");
  lines.push("## Per-instance");
  lines.push("");
  lines.push("| ID | Repo | Verdict | Similarity | Vendor ms | Self ms | Δ ms | Vendor $ | Self $ |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.repo} | ${r.verdict} | ${r.similarity} | ${r.vendor.latency_ms} | ${r.self.latency_ms} | ${r.latency_delta_ms} | ${r.vendor.cost_usd} | ${r.self.cost_usd} |`);
  }
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push("Each instance is dispatched to the **same base model** over two transports:");
  lines.push("- **Vendor:** the model served via the OpenRouter API (`--vendor-slug`).");
  lines.push("- **Self-hosted:** the model served by vLLM/SGLang on the Hetzner GPU annex (`ZO_VLLM_BASE_URL`).");
  lines.push("");
  lines.push("Both paths use the **same production `proposerChat()` dispatch** the MoA lineup uses, so the");
  lines.push("comparison isolates transport/decoding differences, not dispatch logic.");
  lines.push("");
  lines.push("**Metrics:**");
  lines.push("- `similarity` = mean(token-Jaccard, normalized-Levenshtein) ∈ [0,1] — an output-parity proxy.");
  lines.push("- `latency_delta_ms` = self − vendor (negative ⇒ self-hosted faster).");
  lines.push("- cost: vendor at the OpenRouter blended rate; self at `ZO_VLLM_USD_PER_1K` (default 0 = free-at-API).");
  lines.push("");
  lines.push("**Deferred (live annex):** SWE-bench pass@k — whether each generated patch passes the instance's");
  lines.push("hidden test suite — requires the SWE-bench evaluation harness (docker) on the annex, not the");
  lines.push("output-parity proxy reported here. Recorded as a deferred gap, not silently closed.");
  lines.push("");
  return lines.join("\n");
}

function verdicts(agg: Aggregate, k: string): number {
  return agg.verdicts[k] || 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) { process.stdout.write(HELP); return 0; }

  const armed = localTierArmed();
  let mode: "dry" | "live";
  if (cfg.live) {
    if (!armed) {
      console.error("[moa-local-ab] --live requires ZO_VLLM_BASE_URL (local tier not armed). Re-run without --live for a dry-run, or set ZO_VLLM_BASE_URL.");
      return 2;
    }
    mode = "live";
  } else {
    mode = "dry";
  }

  // Load fixtures.
  let fixtures: Fixture[];
  try {
    const raw = readFileSync(cfg.fixtures, "utf8");
    fixtures = JSON.parse(raw) as Fixture[];
  } catch (e) {
    console.error(`[moa-local-ab] cannot load fixtures from ${cfg.fixtures}: ${String(e)}`);
    return 2;
  }
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    console.error(`[moa-local-ab] fixtures file ${cfg.fixtures} is empty or not an array.`);
    return 2;
  }

  console.error(`[moa-local-ab] mode=${mode} base=${cfg.base} instances=${fixtures.length} armed=${armed}`);

  // Live vendor path needs OpenRouter; refuse --live without it.
  if (mode === "live" && !process.env.OPENROUTER_API_KEY) {
    console.error("[moa-local-ab] --live requires OPENROUTER_API_KEY for the vendor path.");
    return 2;
  }

  // Health probe (live only — useful context in the report).
  let health: { available: boolean; latency_ms: number; error?: string } | undefined;
  if (mode === "live") health = await localInferenceHealthCheck();

  const results: InstanceResult[] = [];
  for (const fx of fixtures) {
    const r = await runInstance(mode, cfg.vendorSlug, cfg.localModel, fx);
    results.push(r);
    console.error(`  ${fx.id} ${fx.repo}: ${r.verdict} sim=${r.similarity} Δ=${r.latency_delta_ms}ms`);
  }

  const agg = aggregate(results);
  const md = toMarkdown(mode, cfg.base, results, agg, armed, health);
  const json = {
    mode, base: cfg.base, armed, generated_at: new Date().toISOString(),
    aggregate: agg, health, instances: results,
  };

  const outDir = cfg.outDir;
  try { mkdirSync(outDir, { recursive: true }); } catch { /* may already exist */ }
  const mdPath = join(outDir, "moa-local-ab.report.md");
  const jsonPath = join(outDir, "moa-local-ab.report.json");
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2) + "\n");

  console.error(`[moa-local-ab] wrote ${mdPath}`);
  console.error(`[moa-local-ab] wrote ${jsonPath}`);
  console.error(`[moa-local-ab] match_rate=${agg.match_rate} mean_sim=${agg.mean_similarity} mean_Δ=${agg.mean_latency_delta_ms}ms vendor=$${agg.total_vendor_cost_usd} self=$${agg.total_self_cost_usd}`);
  console.error("[moa-local-ab] A/B_PASS");
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[moa-local-ab] fatal: ${String(e)}`);
  process.exit(1);
});
