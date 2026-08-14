#!/usr/bin/env bun
/**
 * ZOU-402: Per-Agent Observability Stack
 *
 * Tracks per-agent run metrics: model, latency, tokens, exit code, tool calls.
 * Queries model-call-log.jsonl + Dr. agent reports for trend analysis.
 *
 * Usage:
 *   bun agent-observability.ts report          # Full observability report
 *   bun agent-observability.ts html-report     # Self-contained 24-hour HTML report
 *   bun agent-observability.ts trend           # 7-day trend
 *   bun agent-observability.ts anomalies       # >2σ anomaly detection
 *   bun agent-observability.ts agent <name>    # Single agent deep-dive
 *   bun agent-observability.ts coverage        # Fleet instrumentation coverage
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const LOG_FILE = "/home/workspace/.zo/memory/model-call-log.jsonl";
const AGENT_RUNS_DB = "/home/workspace/.zo/agent-runs.jsonl";
const AGENT_DOCTOR_REPORTS = "/home/workspace/Skills/agent-doctor/reports";
const FLEET_ROSTER = join(import.meta.dir, "..", "data", "agent-fleet-roster.json");
const HTML_REPORT_PATH = "/tmp/observability-report.html";

export interface ModelCall {
  ts: string; workload: string; provider: string;
  model: string; latency_ms: number; cost_usd: number;
  input_tokens?: number; output_tokens?: number;
}

export interface AgentRun {
  ts: string; agent_id: string; agent_name: string;
  model: string; exit_code: number; duration_ms: number;
  tool_calls?: number; cost_usd?: number; error?: string;
  source?: string;
}

interface RosterEntry { id: string; label: string; freq: string; instrumented: boolean; active: boolean; }
interface FleetRoster { generated_at: string; fleet_size: number; agents: RosterEntry[]; }

function loadModelCalls(since?: string): ModelCall[] {
  if (!existsSync(LOG_FILE)) return [];
  const rows = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
  const calls = rows.map(r => JSON.parse(r)) as ModelCall[];
  if (since) return calls.filter(c => c.ts >= since);
  return calls;
}

function loadAgentRuns(since?: string): AgentRun[] {
  if (!existsSync(AGENT_RUNS_DB)) return [];
  const rows = readFileSync(AGENT_RUNS_DB, "utf-8").trim().split("\n").filter(Boolean);
  const runs = rows.map(r => JSON.parse(r)) as AgentRun[];
  if (since) return runs.filter(r => r.ts >= since);
  return runs;
}

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function hoursAgo(n: number, now = new Date()): string {
  return new Date(now.getTime() - n * 60 * 60 * 1000).toISOString();
}

function p(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)] || 0;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function report() {
  const weekAgo = daysAgo(7);
  const calls = loadModelCalls(weekAgo);
  const runs = loadAgentRuns(weekAgo);
  const totalCost = calls.reduce((s, c) => s + c.cost_usd, 0);
  const lats = calls.map(c => c.latency_ms);
  const workloads = new Map<string, { count: number; cost: number; avgLat: number; lats: number[] }>();

  for (const c of calls) {
    const w = workloads.get(c.workload) || { count: 0, cost: 0, avgLat: 0, lats: [] };
    w.count++;
    w.cost += c.cost_usd;
    w.lats.push(c.latency_ms);
    workloads.set(c.workload, w);
  }

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  ZOU-402  Per-Agent Observability — 7-Day Report  ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Period: ${weekAgo} → today`);
  console.log(`Model calls: ${calls.length.toLocaleString()}`);
  console.log(`Agent runs:  ${runs.length.toLocaleString()}`);
  console.log(`Total cost:  $${totalCost.toFixed(2)}`);
  console.log(`Latency:     p50=${p(lats, 0.5).toFixed(0)}ms  p95=${p(lats, 0.95).toFixed(0)}ms  max=${Math.max(...lats).toFixed(0)}ms\n`);

  console.log("By Workload:");
  console.log("  Workload          Count   Cost     AvgLat   p95");
  for (const [name, w] of [...workloads.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    const avgLat = w.lats.length ? w.lats.reduce((s, v) => s + v, 0) / w.lats.length : 0;
    console.log(`  ${name.padEnd(18)} ${String(w.count).padStart(5)}  $${w.cost.toFixed(2).padStart(6)}  ${avgLat.toFixed(0).padStart(4)}ms  ${p(w.lats, 0.95).toFixed(0).padStart(5)}ms`);
  }

  if (runs.length > 0) {
    console.log("\nAgent Run Stats:");
    const agentStats = new Map<string, { count: number; failures: number; avgDur: number; durs: number[] }>();
    for (const r of runs) {
      const s = agentStats.get(r.agent_name) || { count: 0, failures: 0, avgDur: 0, durs: [] };
      s.count++;
      if (r.exit_code !== 0) s.failures++;
      s.durs.push(r.duration_ms / 1000);
      agentStats.set(r.agent_name, s);
    }
    for (const [name, s] of [...agentStats.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const avgDur = s.durs.reduce((a, v) => a + v, 0) / s.durs.length;
      const failRate = s.count > 0 ? (s.failures / s.count * 100) : 0;
      const icon = failRate > 10 ? "🔴" : failRate > 2 ? "🟡" : "🟢";
      console.log(`  ${icon} ${name.padEnd(30)} ${String(s.count).padStart(3)} runs  ${avgDur.toFixed(0).padStart(4)}s avg  ${failRate.toFixed(0).padStart(2)}% fail`);
    }
  }

  console.log("\n──────────────────────────────────────────────────\n");
}

function trend() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  ZOU-402  Cost & Latency Trend (7-day)  ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const calls = loadModelCalls(daysAgo(7));
  const byDay = new Map<string, { count: number; cost: number; lats: number[] }>();
  for (const c of calls) {
    const day = c.ts.slice(0, 10);
    const d = byDay.get(day) || { count: 0, cost: 0, lats: [] };
    d.count++; d.cost += c.cost_usd; d.lats.push(c.latency_ms);
    byDay.set(day, d);
  }
  console.log("  Date         Calls   Cost     p50Lat   p95Lat");
  for (const [day, d] of [...byDay.entries()].sort()) {
    console.log(`  ${day}  ${String(d.count).padStart(4)}  $${d.cost.toFixed(2).padStart(6)}  ${p(d.lats, 0.5).toFixed(0).padStart(4)}ms  ${p(d.lats, 0.95).toFixed(0).padStart(5)}ms`);
  }
}

function anomalies() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  ZOU-402  Anomaly Detection (>2σ)       ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const calls = loadModelCalls(daysAgo(7));
  if (calls.length < 10) { console.log("  Insufficient data (<10 calls)"); return; }

  const lats = calls.map(c => c.latency_ms);
  const mean = lats.reduce((s, v) => s + v, 0) / lats.length;
  const sd = stddev(lats);
  const threshold = mean + 2 * sd;

  const anomalies = calls.filter(c => c.latency_ms > threshold);
  if (anomalies.length === 0) {
    console.log("  ✅ No anomalies detected (threshold: >" + threshold.toFixed(0) + "ms)");
    return;
  }
  console.log(`  Threshold: >${threshold.toFixed(0)}ms (μ=${mean.toFixed(0)}ms, σ=${sd.toFixed(0)}ms)`);
  console.log(`  Found ${anomalies.length} anomalies (${(anomalies.length/calls.length*100).toFixed(1)}% of calls):\n`);
  for (const a of anomalies.slice(-10)) {
    console.log(`  ${a.ts.slice(0,19)}  ${a.workload.padEnd(15)} ${a.model.padEnd(15)} ${String(a.latency_ms).padStart(6)}ms  $${a.cost_usd.toFixed(4)}`);
  }
}

function agent(agentName: string) {
  const runs = loadAgentRuns();
  const relevant = runs.filter(r => r.agent_name.toLowerCase().includes(agentName.toLowerCase()));
  if (relevant.length === 0) {
    console.log(`No runs found for "${agentName}"`);
    return;
  }
  console.log(`\n  Agent: ${relevant[0].agent_name}`);
  console.log(`  Total runs: ${relevant.length}`);
  const success = relevant.filter(r => r.exit_code === 0).length;
  console.log(`  Success rate: ${(success/relevant.length*100).toFixed(1)}%`);
  const durs = relevant.map(r => r.duration_ms);
  console.log(`  Duration: p50=${p(durs,0.5).toFixed(0)}ms  p95=${p(durs,0.95).toFixed(0)}ms`);
  const costs = relevant.map(r => r.cost_usd || 0);
  console.log(`  Total cost: $${costs.reduce((s,v)=>s+v,0).toFixed(4)}`);
  console.log(`\n  Recent runs:`);
  for (const r of relevant.slice(-5)) {
    const icon = r.exit_code === 0 ? "✓" : "✗";
    console.log(`  ${icon} ${r.ts.slice(0,19)}  ${r.model.padEnd(20)}  ${String(r.duration_ms/1000).padStart(4)}s  exit=${r.exit_code}`);
  }
}

function coverage() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  ZOU-402  Fleet Instrumentation Coverage          ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (!existsSync(FLEET_ROSTER)) {
    console.log(`  No roster at ${FLEET_ROSTER}`);
    console.log("  Regenerate the snapshot from mcp__zo__list_automations, then re-run.");
    return;
  }
  const roster = JSON.parse(readFileSync(FLEET_ROSTER, "utf-8")) as FleetRoster;
  // Coverage is measured over the agents that actually run. Paused/disabled
  // automations can never emit telemetry, so counting them only dilutes the metric.
  const dormant = roster.agents.filter(a => !a.active);
  const fleet = roster.agents.filter(a => a.active);
  const instrumented = fleet.filter(a => a.instrumented);
  const dark = fleet.filter(a => !a.instrumented);
  const pct = fleet.length ? (instrumented.length / fleet.length) * 100 : 0;
  const bar = "█".repeat(Math.round(pct / 5)).padEnd(20, "░");

  console.log(`  Roster snapshot: ${roster.generated_at}  (regenerate from mcp__zo__list_automations)`);
  console.log(`  Active fleet:    ${fleet.length}  (+${dormant.length} paused/disabled, excluded)`);
  console.log(`  Instrumented:    ${instrumented.length}/${fleet.length}  [${bar}] ${pct.toFixed(1)}%`);
  console.log(`  Dark (active, no run logging): ${dark.length}\n`);

  // Where the dark agents are — high-frequency ones are the priority to wire first.
  const freqOrder = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY", "?"];
  const byFreq = new Map<string, { total: number; instrumented: number }>();
  for (const a of fleet) {
    const f = freqOrder.includes(a.freq) ? a.freq : "?";
    const s = byFreq.get(f) || { total: 0, instrumented: 0 };
    s.total++; if (a.instrumented) s.instrumented++;
    byFreq.set(f, s);
  }
  console.log("  By cadence (instrumented / total):");
  for (const f of freqOrder) {
    const s = byFreq.get(f);
    if (!s) continue;
    console.log(`    ${f.padEnd(8)} ${String(s.instrumented).padStart(2)}/${String(s.total).padStart(2)}`);
  }

  // Liveness cross-check: which agents have actually emitted real run records lately.
  const runs = loadAgentRuns(daysAgo(30)).filter(r => r.source !== "seed");
  const emitters = new Set(runs.map(r => r.agent_id));
  const seeded = loadAgentRuns(daysAgo(30)).length - runs.length;
  console.log(`\n  Real run records (30d): ${runs.length} from ${emitters.size} distinct agent id(s)` +
    (seeded > 0 ? `  (+${seeded} seeded rows excluded)` : ""));

  if (instrumented.length > 0) {
    console.log("\n  Instrumented agents:");
    for (const a of instrumented) console.log(`    ✓ ${a.freq.padEnd(8)} ${a.label.slice(0, 64)}`);
  }

  console.log("\n  Next step: wire dark agents with the agent-logger `run` wrapper —");
  console.log("    bun agent-logger.ts run --agent-id <id> --agent-name <name> --model <m> -- <cmd>");
  console.log("  Prioritize HOURLY/DAILY agents; they generate the most signal.\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] || char);
}

export function renderHtmlReport(
  calls: ModelCall[],
  runs: AgentRun[],
  now = new Date(),
): string {
  const totalCost = calls.reduce((sum, call) => sum + (call.cost_usd || 0), 0);
  const latencies = calls.map(call => call.latency_ms).filter(Number.isFinite);
  const successCount = runs.filter(run => run.exit_code === 0).length;
  const successRate = runs.length ? (successCount / runs.length) * 100 : 100;
  const meanLatency = latencies.length
    ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
    : 0;
  const latencyStddev = stddev(latencies);
  const anomalyThreshold = meanLatency + 2 * latencyStddev;
  const anomalyCount = latencyStddev > 0
    ? latencies.filter(value => value > anomalyThreshold).length
    : 0;
  const anomalyRate = calls.length ? (anomalyCount / calls.length) * 100 : 0;

  const agentStats = new Map<string, {
    count: number;
    failures: number;
    durations: number[];
    cost: number;
  }>();
  for (const run of runs) {
    const stat = agentStats.get(run.agent_name) || {
      count: 0,
      failures: 0,
      durations: [],
      cost: 0,
    };
    stat.count++;
    if (run.exit_code !== 0) stat.failures++;
    stat.durations.push(run.duration_ms / 1000);
    stat.cost += run.cost_usd || 0;
    agentStats.set(run.agent_name, stat);
  }

  const highFailAgents = [...agentStats.entries()]
    .map(([name, stat]) => ({
      name,
      ...stat,
      failRate: stat.count ? stat.failures / stat.count : 0,
    }))
    .filter(agentStat => agentStat.failRate > 0.2)
    .sort((a, b) => b.failRate - a.failRate);
  const warning = highFailAgents.length > 0 || anomalyRate > 5;
  const statusText = warning
    ? `${highFailAgents.length} high-fail agent${highFailAgents.length === 1 ? "" : "s"}, ${anomalyRate.toFixed(1)}% anomalies`
    : "All clear";

  const agentRows = [...agentStats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, stat]) => {
      const failRate = stat.count ? stat.failures / stat.count : 0;
      const averageDuration = stat.durations.length
        ? stat.durations.reduce((sum, value) => sum + value, 0) / stat.durations.length
        : 0;
      const state = failRate > 0.2 ? "critical" : failRate > 0.05 ? "warning" : "healthy";
      return `<tr>
        <td><span class="state ${state}"></span>${escapeHtml(name)}</td>
        <td>${stat.count}</td>
        <td>${stat.failures}</td>
        <td class="${state}">${(failRate * 100).toFixed(1)}%</td>
        <td>${averageDuration.toFixed(0)}s</td>
        <td>$${stat.cost.toFixed(4)}</td>
      </tr>`;
    })
    .join("");

  const workloadCounts = new Map<string, number>();
  for (const call of calls) {
    workloadCounts.set(call.workload, (workloadCounts.get(call.workload) || 0) + 1);
  }
  const maxWorkloadCount = Math.max(1, ...workloadCounts.values());
  const workloadRows = [...workloadCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([workload, count]) => {
      const width = Math.max(2, Math.round((count / maxWorkloadCount) * 100));
      return `<div class="workload">
        <div class="workload-label"><span>${escapeHtml(workload)}</span><strong>${count}</strong></div>
        <div class="bar"><span style="width:${width}%"></span></div>
      </div>`;
    })
    .join("");

  const highFailSummary = highFailAgents.length
    ? `<ul>${highFailAgents.map(agentStat =>
      `<li><strong>${escapeHtml(agentStat.name)}</strong>: ${(agentStat.failRate * 100).toFixed(1)}% failure rate across ${agentStat.count} run${agentStat.count === 1 ? "" : "s"}</li>`
    ).join("")}</ul>`
    : "<p>No agent exceeded the 20% failure threshold.</p>";

  const generatedAt = now.toISOString();
  const windowStart = hoursAgo(24, now);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Zouroboros Agent Observability Report</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#18212f;font:14px/1.5 Arial,sans-serif}
    .report{max-width:1050px;margin:0 auto;background:#fff}.header{padding:34px 40px;background:#151b26;color:#fff;border-bottom:5px solid ${warning ? "#d97706" : "#059669"}}
    .header h1{margin:0 0 8px;font-size:28px}.header p{margin:3px 0;color:#d1d5db}.content{padding:32px 40px}
    .status{padding:16px 18px;border:1px solid ${warning ? "#f59e0b" : "#10b981"};background:${warning ? "#fffbeb" : "#ecfdf5"};margin-bottom:24px}
    .status strong{color:${warning ? "#92400e" : "#065f46"}}.metrics{display:flex;flex-wrap:wrap;margin:0 -5px 30px}
    .metric{width:calc(33.333% - 10px);margin:5px;padding:14px;border:1px solid #e5e7eb;background:#f9fafb}.metric b{display:block;font-size:22px;color:#111827}.metric span{color:#6b7280;font-size:11px;text-transform:uppercase}
    h2{margin:28px 0 12px;font-size:18px;border-bottom:2px solid #e5e7eb;padding-bottom:8px}table{width:100%;border-collapse:collapse}
    th,td{padding:9px 10px;text-align:right;border-bottom:1px solid #e5e7eb}th:first-child,td:first-child{text-align:left}.state{display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%}
    .state.healthy{background:#059669}.state.warning{background:#d97706}.state.critical{background:#dc2626}.healthy{color:#047857}.warning{color:#b45309}.critical{color:#b91c1c;font-weight:bold}
    .workloads{display:grid;grid-template-columns:repeat(2,1fr);gap:12px 22px}.workload-label{display:flex;justify-content:space-between}.bar{height:7px;background:#e5e7eb;margin-top:4px}.bar span{display:block;height:100%;background:#2563eb}
    .empty{color:#6b7280;font-style:italic}.meta{margin-top:30px;padding-top:16px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px}
    @media(max-width:760px){.metric{width:calc(50% - 10px)}.workloads{grid-template-columns:1fr}.content,.header{padding-left:20px;padding-right:20px}}
  </style>
</head>
<body>
  <main class="report">
    <header class="header">
      <h1>Zouroboros Agent Observability</h1>
      <p>Rolling 24-hour fleet health report</p>
      <p>${escapeHtml(windowStart)} through ${escapeHtml(generatedAt)}</p>
    </header>
    <div class="content">
      <section class="status"><strong>${warning ? "Warning" : "Healthy"}:</strong> ${escapeHtml(statusText)}</section>
      <section class="metrics">
        <div class="metric"><b>${calls.length.toLocaleString("en-US")}</b><span>Model calls</span></div>
        <div class="metric"><b>${runs.length.toLocaleString("en-US")}</b><span>Agent runs</span></div>
        <div class="metric"><b>$${totalCost.toFixed(2)}</b><span>Model cost</span></div>
        <div class="metric"><b>${successRate.toFixed(1)}%</b><span>Success rate</span></div>
        <div class="metric"><b>${p(latencies, 0.95).toFixed(0)}ms</b><span>p95 latency</span></div>
        <div class="metric"><b>${anomalyRate.toFixed(1)}%</b><span>Anomaly rate</span></div>
      </section>
      <section>
        <h2>Agent Run Details</h2>
        ${agentRows ? `<table><thead><tr><th>Agent</th><th>Runs</th><th>Failures</th><th>Fail rate</th><th>Avg duration</th><th>Cost</th></tr></thead><tbody>${agentRows}</tbody></table>` : '<p class="empty">No agent runs recorded in this window.</p>'}
      </section>
      <section>
        <h2>High-Fail Agents</h2>
        ${highFailSummary}
      </section>
      <section>
        <h2>Workload Distribution</h2>
        ${workloadRows ? `<div class="workloads">${workloadRows}</div>` : '<p class="empty">No model calls recorded in this window.</p>'}
      </section>
      <p class="meta">Generated ${escapeHtml(generatedAt)}. Latency anomalies are calls above mean + 2 standard deviations.</p>
    </div>
  </main>
</body>
</html>`;
}

export function htmlReport(now = new Date()): string {
  const since = hoursAgo(24, now);
  const calls = loadModelCalls(since);
  const runs = loadAgentRuns(since);
  writeFileSync(HTML_REPORT_PATH, renderHtmlReport(calls, runs, now), "utf-8");
  console.log(`HTML report written to ${HTML_REPORT_PATH}`);
  console.log(`Period: last 24h (since ${since})`);
  return HTML_REPORT_PATH;
}

// ── Main ──
if (import.meta.main) {
  const cmd = process.argv[2] || "report";
  switch (cmd) {
    case "report": report(); break;
    case "html-report": htmlReport(); break;
    case "trend": trend(); break;
    case "anomalies": anomalies(); break;
    case "coverage": coverage(); break;
    case "agent":
      if (!process.argv[3]) { console.log("Usage: bun agent-observability.ts agent <name>"); break; }
      agent(process.argv[3]);
      break;
    default:
      console.log("Usage: bun agent-observability.ts [report|html-report|trend|anomalies|coverage|agent <name>]");
  }
}
