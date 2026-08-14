#!/usr/bin/env bun
/**
 * Operator Digest — a weekly plain-language briefing of what Zouroboros did on its own.
 *
 * The loop (self-heal introspect→prescribe→evolve, the model healer, the consensus gate,
 * the curiosity explorer) runs unattended. Each component writes structured JSON to the
 * Zouroboros data dir. On their own those files are operator-hostile blobs. This script
 * reads them for a time window and renders ONE human-facing briefing: what changed and
 * why, what the verification layer is watching, and the short list of things that actually
 * need the operator's judgment. It is read-only — it never mutates loop state.
 *
 * Output: a markdown file, a styled HTML file (email body), and a PDF (email attachment),
 * plus a JSON manifest on stdout for the scheduled agent to act on (subject, paths, counts).
 *
 * Sources (all optional — a missing file degrades to "nothing this week", never a crash):
 *   evolution-history.json     autonomous interventions: playbook, metric, delta, revert
 *   intervention-ledger.json   per-intervention state deltas + anti-Goodhart drift flags
 *   chronicle.json + votes     curiosity proposals; accepted votes = escalations for a human
 *   healer-state.json          model failovers + per-model health probes
 *   reputation.json            consensus voter reputation (agreement / vendor-error rates)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { collectGovernanceEvidence } from "./governance-evidence";

// ── args / config ─────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = "true";
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`operator-digest — weekly plain-language Zouroboros activity briefing

Usage: bun digest.ts [--days N] [--since ISO] [--data-dir PATH] [--healer-state PATH] [--out DIR] [--no-pdf]

  --days N         window length in days (default 7)
  --since ISO      explicit window start (overrides --days)
  --data-dir PATH  Zouroboros data dir (default $ZOUROBOROS_DATA_DIR or /root/.zouroboros)
  --healer-state   healer-state.json path (default /home/workspace/.zouroboros/healer-state.json)
  --out DIR        output dir for md/html/pdf (default <data-dir>/operator-digest)
  --prompt-metrics confirmation-prompt JSONL exported by the production permission UI
  --adapter-inventory versioned runtime adapter inventory JSON
  --graph-query-script embedded GraphRAG read-only query entrypoint
  --graph-db PATH   populated embedded FalkorDB data directory
  --skip-graph      record graph evidence as explicitly unavailable
  --no-pdf         skip PDF rendering

Prints a JSON manifest to stdout: { status, subject, summary, mdPath, htmlPath, pdfPath, needsJudgment, changedCount, healthOk }`);
  process.exit(0);
}

const DATA_DIR = args["data-dir"] || process.env.ZOUROBOROS_DATA_DIR || "/root/.zouroboros";
const HEALER_STATE =
  args["healer-state"] || process.env.ZOUROBOROS_HEALER_STATE || "/home/workspace/.zouroboros/healer-state.json";
const DAYS = Number(args.days || 7);
const NOW = Date.now();
const SINCE = args.since ? Date.parse(args.since) : NOW - DAYS * 86_400_000;
const OUT_DIR = args.out || join(DATA_DIR, "operator-digest");
const MAKE_PDF = args["no-pdf"] !== "true";
const governance = collectGovernanceEvidence({
  since: SINCE,
  dataDir: DATA_DIR,
  promptMetricsPath: args["prompt-metrics"],
  adapterInventoryPath: args["adapter-inventory"],
  graphQueryScript: args["graph-query-script"],
  graphDbPath: args["graph-db"],
  skipGraph: args["skip-graph"] === "true",
});

// ── source shapes (mirrors of the writers' types) ──────────────────────────────
interface MetricSnap { name: string; score: number; value: number }
interface Scorecard { composite: number; metrics: MetricSnap[] }
interface HistoryEntry {
  timestamp: string; prescriptionId: string; playbookName: string; metricName: string;
  baseline: Scorecard; postFlight: Scorecard | null; delta: number; success: boolean; reverted: boolean;
}
interface InterventionRecord {
  prescriptionId: string; playbookName: string; metricName: string; createdAt: number;
  success: boolean; reverted: boolean;
  stateDelta: { compositeDelta: number } | null;
  drift: { divergence: number; goodhartFlag: boolean } | null;
}
interface ChronicleEntry {
  id: string; title: string; domain: string; risk: string; status: string;
  rationale: string; approach: string; expectedGain: number; proposedAt: number;
}
interface Votes { votes: Record<string, { decision: string; votedAt: number }> }
interface SwitchRecord { agentTitle: string; originalModel: string; currentModel: string; switchedAt: string; reason: string }
interface ProbeResult { model: string; healthy: boolean; health: string; checkedAt: string; error?: string }
interface HealerState { switches: SwitchRecord[]; lastProbe: Record<string, ProbeResult>; healCount?: number; restoreCount?: number }
interface Voter { agreement_rate: number; vendor_error_rate: number; effective_weight: number; total_votes: number }
interface Reputation { updated: string; runs: number; voters: Record<string, Voter> }

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

// ── humanizers ──────────────────────────────────────────────────────────────────
const METRIC_LABELS: Record<string, string> = {
  composite: "overall system health score",
  graph_connectivity: "how well its knowledge is interconnected",
  density: "memory density",
  execution_coverage: "how many of its procedures actually get used",
  procedure_freshness: "how current its procedures are",
  orphan_ratio: "share of disconnected memories",
  wiring_gap: "unwired capabilities",
  recall: "memory recall accuracy",
  precision: "memory precision",
};
function humanMetric(name: string): string {
  return METRIC_LABELS[name] || name.replace(/[_-]+/g, " ").trim();
}
const FALLBACK_CHAIN = loadJson<Record<string, unknown>>(
  "/home/workspace/Skills/agent-model-healer/assets/fallback-chain.json",
  {}
);
const MODEL_LABELS = (FALLBACK_CHAIN.modelLabels as Record<string, string>) || {};
// Models the healer deliberately retired from the catalog (any `_removed*` block). A stale
// failing probe for a retired model is expected fallout of the removal, not an operator
// concern — we filter those out so the digest only surfaces live models that are failing.
const RETIRED_MODELS = new Set<string>();
for (const [k, v] of Object.entries(FALLBACK_CHAIN)) {
  if (!k.startsWith("_removed") || typeof v !== "object" || v === null) continue;
  const block = v as { models?: unknown; _removed_models?: unknown };
  for (const arr of [block.models, block._removed_models]) {
    if (Array.isArray(arr)) for (const m of arr) if (typeof m === "string") RETIRED_MODELS.add(m);
  }
}
function modelLabel(id: string): string {
  return MODEL_LABELS[id] || id;
}
function pct(n: number): string {
  const v = n * 100;
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}
function ago(ms: number): string {
  const d = Math.round((NOW - ms) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── gather ────────────────────────────────────────────────────────────────────
const history = loadJson<{ entries?: HistoryEntry[] }>(join(DATA_DIR, "evolution-history.json"), {}).entries || [];
const ledger = loadJson<{ entries?: InterventionRecord[] }>(join(DATA_DIR, "intervention-ledger.json"), {}).entries || [];
const chronicle = loadJson<{ entries?: ChronicleEntry[]; window?: string }>(join(DATA_DIR, "chronicle.json"), {});
const proposals = chronicle.entries || [];
const votes = loadJson<Votes>(join(DATA_DIR, "chronicle-votes.json"), { votes: {} }).votes;
const healer = loadJson<HealerState>(HEALER_STATE, { switches: [], lastProbe: {} });
const reputation = loadJson<Reputation | null>(join(DATA_DIR, "reputation.json"), null);

// drift cross-ref: prescriptionId -> goodhart drift (from the ledger)
const driftByPrescription = new Map<string, InterventionRecord>();
for (const r of ledger) if (r.drift?.goodhartFlag) driftByPrescription.set(r.prescriptionId, r);

// changes applied this window (evolution-history is the spine; ledger enriches with drift)
const changes = history
  .filter((h) => Date.parse(h.timestamp) >= SINCE)
  .map((h) => ({
    playbook: h.playbookName,
    metric: h.metricName,
    delta: h.delta,
    success: h.success,
    reverted: h.reverted,
    compositeBefore: h.baseline?.composite,
    compositeAfter: h.postFlight?.composite ?? null,
    when: Date.parse(h.timestamp),
    drift: driftByPrescription.get(h.prescriptionId) || null,
  }))
  .sort((a, b) => b.when - a.when);

// any drift flags in window (even if their evolution entry is older / absent)
const driftFlags = ledger
  .filter((r) => r.drift?.goodhartFlag && r.createdAt >= SINCE)
  .map((r) => ({ playbook: r.playbookName, metric: r.metricName, divergence: r.drift!.divergence, when: r.createdAt }))
  .sort((a, b) => b.when - a.when);

// model failovers in window + models failing their last health probe
const failovers = (healer.switches || [])
  .filter((s) => Date.parse(s.switchedAt) >= SINCE)
  .map((s) => ({ agent: s.agentTitle, from: modelLabel(s.originalModel), to: modelLabel(s.currentModel), reason: s.reason, when: Date.parse(s.switchedAt) }));
const unhealthyModels = Object.values(healer.lastProbe || {})
  .filter((p) => p.healthy === false && !RETIRED_MODELS.has(p.model))
  .map((p) => ({
    model: p.model,
    label: modelLabel(p.model),
    error: p.error || "unhealthy",
    probedAgo: ago(Date.parse(p.checkedAt)),
  }));

// curiosity: accepted votes that haven't been acted on = escalations needing a human
const escalations = proposals
  .filter((p) => votes[p.id]?.decision === "accept")
  .map((p) => ({ ...p, votedAt: votes[p.id]!.votedAt }))
  .sort((a, b) => b.expectedGain - a.expectedGain);
const escalationIds = new Set(escalations.map((e) => e.id));
// top held proposals (open questions the explorer raised, no verdict yet)
const heldHighGain = proposals
  .filter((p) => p.status === "held" && !escalationIds.has(p.id))
  .sort((a, b) => b.expectedGain - a.expectedGain)
  .slice(0, 5);

// consensus voters whose verdicts are no longer trusted (zero effective weight w/ votes cast)
const reputationConcerns = reputation
  ? Object.entries(reputation.voters)
      .filter(([, v]) => v.total_votes >= 5 && v.effective_weight === 0)
      .map(([model, v]) => ({ model, agreement: v.agreement_rate, vendorErr: v.vendor_error_rate, votes: v.total_votes }))
  : [];

// latest known composite (post-flight of most recent change, else most recent baseline)
const latestComposite =
  changes.find((c) => c.compositeAfter != null)?.compositeAfter ??
  (history.length ? history[history.length - 1].postFlight?.composite ?? history[history.length - 1].baseline?.composite : null);

const reverts = changes.filter((c) => c.reverted).length;
const governanceReviewCount =
  governance.unsupported_calls.length
  + governance.anomalies.length
  + governance.approval_failures.reuse
  + governance.approval_failures.revocation
  + governance.approval_failures.other
  + (governance.prompts.status === "ready" ? 0 : 1)
  + (governance.graph.status === "ready" ? 0 : 1);
const governanceAction = governance.status === "rejected" || governance.unapproved_t2_executions > 0;
const needsJudgment = escalations.length + driftFlags.length + unhealthyModels.length + governanceReviewCount;
// ❌ is reserved for the loop actually misbehaving: an anti-Goodhart drift flag means a
// change improved its visible metric while the hidden held-out set moved against it (metric
// gaming). A revert is the loop self-correcting — informational, not an alarm. Unhealthy
// probes and accepted escalations are ⚠️ "review", not ❌.
const driftDetected = driftFlags.length > 0;
const level: "action" | "review" | "clear" = driftDetected || governanceAction
  ? "action"
  : needsJudgment > 0
    ? "review"
    : "clear";

const windowLabel = chronicle.window || `week ending ${new Date(NOW).toISOString().slice(0, 10)}`;
const statusEmoji = level === "action" ? "❌" : level === "review" ? "⚠️" : "✅";
const headline =
  governance.status === "rejected"
    ? "Action needed — canonical governance evidence failed integrity verification"
    : governance.unapproved_t2_executions > 0
      ? `Action needed — ${governance.unapproved_t2_executions} unapproved T2 execution${governance.unapproved_t2_executions === 1 ? "" : "s"} detected`
  : level === "action"
    ? `Action needed — ${driftFlags.length} change${driftFlags.length === 1 ? "" : "s"} may be gaming a metric`
    : level === "review"
    ? `${needsJudgment} item${needsJudgment === 1 ? "" : "s"} for your review`
    : "All clear — the loop ran clean";

// ── plain-language bottom line ──────────────────────────────────────────────────
function bottomLine(): string {
  const parts: string[] = [];
  if (changes.length === 0) parts.push("Zouroboros made no autonomous changes to itself this week.");
  else {
    const good = changes.filter((c) => c.success && !c.reverted).length;
    parts.push(
      `Zouroboros applied ${changes.length} self-improvement${changes.length === 1 ? "" : "s"} this week (${good} held, ${reverts} rolled back).`
    );
  }
  if (failovers.length) parts.push(`It switched ${failovers.length} agent model${failovers.length === 1 ? "" : "s"} to a backup after a failure.`);
  if (driftFlags.length) parts.push(`${driftFlags.length} change${driftFlags.length === 1 ? "" : "s"} tripped the anti-gaming tripwire and need a look.`);
  if (escalations.length) parts.push(`${escalations.length} proposal${escalations.length === 1 ? "" : "s"} you accepted ${escalations.length === 1 ? "is" : "are"} waiting to be escalated.`);
  if (unhealthyModels.length) parts.push(`${unhealthyModels.length} model${unhealthyModels.length === 1 ? " was" : "s were"} failing health checks at last probe.`);
  if (governance.status === "rejected") parts.push("The canonical governance ledger failed integrity verification, so no autonomy records were counted as evidence.");
  else {
    const t0 = Object.values(governance.t0_by_class).reduce((sum, count) => sum + count, 0);
    parts.push(`Governance evidence contains ${t0} T0 action${t0 === 1 ? "" : "s"}, ${governance.t1_actions.length} T1 action${governance.t1_actions.length === 1 ? "" : "s"}, and ${governance.t2_denials.length} T2 denial${governance.t2_denials.length === 1 ? "" : "s"}.`);
  }
  if (governance.prompts.status !== "ready") parts.push("Matched confirmation-prompt evidence is not ready.");
  if (governance.graph.status !== "ready") parts.push("The embedded governance graph query is unavailable or unpopulated.");
  if (needsJudgment === 0) parts.push("Nothing needs your attention.");
  return parts.join(" ");
}

// ── markdown ────────────────────────────────────────────────────────────────────
function renderMarkdown(): string {
  const L: string[] = [];
  L.push(`# Operator Digest — ${windowLabel}`, "");
  L.push(`**${statusEmoji} ${headline}**`, "");
  L.push(`> ${bottomLine()}`, "");
  if (latestComposite != null) L.push(`Current overall health score: **${(latestComposite * 100).toFixed(0)}/100**`, "");

  L.push("## What changed this week", "");
  if (!changes.length) L.push("_No autonomous changes were applied. The loop observed but did not modify the system._", "");
  else for (const c of changes) {
    const tag = c.reverted ? "↩️ rolled back" : c.success ? "✅ kept" : "⚠️ no effect";
    L.push(`- **${esc(c.playbook)}** tuned *${humanMetric(c.metric)}* (${pct(c.delta)}) — ${tag}, ${ago(c.when)}.${c.drift ? " ⚠️ tripped the anti-gaming check." : ""}`);
  }
  L.push("");

  if (failovers.length || unhealthyModels.length) {
    L.push("## Model health", "");
    for (const f of failovers) L.push(`- Switched **${esc(f.agent)}** from ${esc(f.from)} to ${esc(f.to)} after a failure (${ago(f.when)}). Reason: ${esc(f.reason)}.`);
    for (const m of unhealthyModels) L.push(`- ⚠️ **${esc(m.label)}** failed its last health check (${m.probedAgo}): ${esc(m.error)}.`);
    L.push("");
  }

  L.push("## Needs your judgment", "");
  if (needsJudgment === 0) L.push("_Nothing is waiting on you._", "");
  else {
    for (const e of escalations) L.push(`- **Escalate?** ${esc(e.title)} — you accepted this; it needs a real fix cycle. (${esc(e.domain)}, payoff ${e.expectedGain.toFixed(2)})`);
    for (const d of driftFlags) L.push(`- **Review:** *${esc(d.playbook)}* improved *${humanMetric(d.metric)}* but the hidden held-out set moved against it (divergence ${d.divergence.toFixed(2)}) — possible metric-gaming, ${ago(d.when)}.`);
    for (const m of unhealthyModels) L.push(`- **Check model:** ${esc(m.label)} failed its last health check (${m.probedAgo}) — confirm it recovered, since a stale probe can overstate this.`);
    L.push("");
  }

  if (heldHighGain.length) {
    L.push("## Open questions the system raised", "");
    L.push("_Hypotheses from the curiosity explorer — no action taken, listed by potential payoff. Vote on the Chronicle page to accept or dismiss._", "");
    for (const p of heldHighGain) L.push(`- ${esc(p.title)} — ${esc(p.rationale)} (payoff ${p.expectedGain.toFixed(2)})`);
    L.push("");
  }

  if (reputationConcerns.length) {
    L.push("## Verification layer", "");
    L.push(`Consensus gate has run ${reputation?.runs ?? "?"} times. The following reviewers are currently distrusted (zero weight):`, "");
    for (const r of reputationConcerns) L.push(`- **${esc(r.model)}** — ${(r.agreement * 100).toFixed(0)}% agreement, ${(r.vendorErr * 100).toFixed(0)}% vendor errors over ${r.votes} votes.`);
    L.push("");
  }

  L.push("## Governance evidence", "");
  L.push(`- Canonical ledger: **${governance.status}** (${governance.ledger.count} records; chain ${governance.ledger.chain_ok ? "valid" : "invalid"}; anchor ${governance.ledger.anchor_ok ? "valid" : "invalid"}).`);
  if (governance.status === "accepted") {
    const t0Entries = Object.entries(governance.t0_by_class).sort(([left], [right]) => left.localeCompare(right));
    L.push(`- T0 by class: ${t0Entries.length ? t0Entries.map(([name, count]) => `${esc(name)}=${count}`).join(", ") : "none"}.`);
    for (const action of governance.t1_actions) L.push(`- **T1:** ${esc(action.action)} on ${esc(action.resource)} via ${esc(action.runtime)} (${esc(action.mode)}).`);
    for (const action of governance.t2_denials) L.push(`- **T2 denied:** ${esc(action.action)} on ${esc(action.resource)} via ${esc(action.runtime)}; authorization ${esc(action.authorization)}.`);
    L.push(`- Unapproved T2 executions: **${governance.unapproved_t2_executions}**.`);
  }
  for (const anomaly of governance.anomalies) L.push(`- **Anomaly:** ${esc(anomaly)}.`);
  for (const action of governance.unsupported_calls) L.push(`- **Unsupported runtime:** ${esc(action.runtime)} attempted ${esc(action.action)}; no governed adapter evidence claimed.`);
  L.push(`- Approval failures: reuse=${governance.approval_failures.reuse}, revocation=${governance.approval_failures.revocation}, other=${governance.approval_failures.other}.`);
  if (governance.prompts.status === "ready") {
    const reduction = governance.prompts.prompt_reduction == null ? "not computable" : pct(governance.prompts.prompt_reduction);
    L.push(`- Confirmation prompts: ${governance.prompts.before_prompts} before → ${governance.prompts.after_prompts} after across ${governance.prompts.matched_workloads} exactly matched workload${governance.prompts.matched_workloads === 1 ? "" : "s"} (${reduction}); ${governance.prompts.unmatched_before + governance.prompts.unmatched_after} one-sided and ${governance.prompts.invalid_pairs} invalid pair${governance.prompts.invalid_pairs === 1 ? "" : "s"} excluded.`);
  } else {
    L.push(`- Confirmation prompts: **${governance.prompts.status}**${governance.prompts.error ? ` — ${esc(governance.prompts.error)}` : ""}; no reduction claim.`);
  }
  L.push(`- Embedded graph: **${governance.graph.status}**${governance.graph.status === "ready" ? ` (${governance.graph.row_count} bounded rows, result ${governance.graph.result_sha256})` : governance.graph.error ? ` — ${esc(governance.graph.error)}` : ""}.`);
  const supportedAdapters = governance.adapters.adapters.filter((adapter) => adapter.supported);
  const unsupportedAdapters = governance.adapters.adapters.filter((adapter) => !adapter.supported);
  L.push(`- Adapter inventory: ${supportedAdapters.map((adapter) => esc(adapter.id)).join(", ") || "none"} supported; ${unsupportedAdapters.map((adapter) => esc(adapter.id)).join(", ") || "none"} explicitly unsupported.`, "");

  L.push("---", `_Generated ${new Date(NOW).toISOString().replace("T", " ").slice(0, 16)} UTC · read-only · Alaric / Zouroboros loop._`);
  return L.join("\n");
}

// ── html (email body + pdf source) ──────────────────────────────────────────────
function mdLineToHtml(line: string): string {
  // minimal: **bold**, *italic*, `code`
  return line
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}
function section(title: string, body: string): string {
  return `<h2 style="font-size:15px;margin:24px 0 8px;color:#0f766e;border-bottom:1px solid #e5e7eb;padding-bottom:4px;">${esc(title)}</h2>${body}`;
}
function list(items: string[]): string {
  if (!items.length) return `<p style="color:#6b7280;margin:6px 0;">Nothing here this period.</p>`;
  return `<ul style="margin:6px 0 6px 0;padding-left:18px;">${items.map((i) => `<li style="margin:4px 0;line-height:1.5;">${mdLineToHtml(i)}</li>`).join("")}</ul>`;
}
function renderHtml(): string {
  const accent = level === "action" ? "#b91c1c" : level === "review" ? "#b45309" : "#0f766e";
  const changeItems = changes.length
    ? changes.map((c) => {
        const tag = c.reverted ? "↩️ rolled back" : c.success ? "✅ kept" : "⚠️ no effect";
        return `**${esc(c.playbook)}** tuned *${humanMetric(c.metric)}* (${pct(c.delta)}) — ${tag}, ${ago(c.when)}.${c.drift ? " ⚠️ tripped the anti-gaming check." : ""}`;
      })
    : [];
  const judgmentItems: string[] = [
    ...escalations.map((e) => `**Escalate?** ${esc(e.title)} — you accepted this; it needs a real fix cycle. (${esc(e.domain)}, payoff ${e.expectedGain.toFixed(2)})`),
    ...driftFlags.map((d) => `**Review:** *${esc(d.playbook)}* improved *${humanMetric(d.metric)}* but the hidden held-out set moved against it (divergence ${d.divergence.toFixed(2)}) — possible metric-gaming, ${ago(d.when)}.`),
    ...unhealthyModels.map((m) => `**Check model:** ${esc(m.label)} failed its last health check (${m.probedAgo}) — confirm it recovered, since a stale probe can overstate this.`),
  ];
  const healthItems = [
    ...failovers.map((f) => `Switched **${esc(f.agent)}** from ${esc(f.from)} to ${esc(f.to)} after a failure (${ago(f.when)}). Reason: ${esc(f.reason)}.`),
    ...unhealthyModels.map((m) => `⚠️ **${esc(m.label)}** failed its last health check (${m.probedAgo}): ${esc(m.error)}.`),
  ];
  const curiosityItems = heldHighGain.map((p) => `${esc(p.title)} — ${esc(p.rationale)} (payoff ${p.expectedGain.toFixed(2)})`);
  const repItems = reputationConcerns.map((r) => `**${esc(r.model)}** — ${(r.agreement * 100).toFixed(0)}% agreement, ${(r.vendorErr * 100).toFixed(0)}% vendor errors over ${r.votes} votes.`);
  const governanceItems = [
    `Canonical ledger: **${governance.status}** (${governance.ledger.count} records; chain ${governance.ledger.chain_ok ? "valid" : "invalid"}; anchor ${governance.ledger.anchor_ok ? "valid" : "invalid"}).`,
    `T1 actions: ${governance.t1_actions.length}; T2 denials: ${governance.t2_denials.length}; unapproved T2 executions: **${governance.unapproved_t2_executions}**.`,
    `Approval failures: reuse=${governance.approval_failures.reuse}, revocation=${governance.approval_failures.revocation}, other=${governance.approval_failures.other}.`,
    governance.prompts.status === "ready"
      ? `Confirmation prompts: ${governance.prompts.before_prompts} before → ${governance.prompts.after_prompts} after across ${governance.prompts.matched_workloads} exactly matched workloads.`
      : `Confirmation prompts: **${governance.prompts.status}**; no reduction claim.`,
    governance.graph.status === "ready"
      ? `Embedded graph: **ready** (${governance.graph.row_count} bounded rows).`
      : `Embedded graph: **${governance.graph.status}**${governance.graph.error ? ` — ${esc(governance.graph.error)}` : ""}.`,
    ...governance.anomalies.map((item) => `**Anomaly:** ${esc(item)}.`),
    ...governance.unsupported_calls.map((item) => `**Unsupported runtime:** ${esc(item.runtime)} attempted ${esc(item.action)}; no governed adapter evidence claimed.`),
  ];

  const scoreBadge =
    latestComposite != null
      ? `<span style="display:inline-block;background:${accent}11;color:${accent};font-weight:700;border:1px solid ${accent}33;border-radius:999px;padding:3px 12px;font-size:13px;">Health ${(latestComposite * 100).toFixed(0)}/100</span>`
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#f3f4f6;}</style></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;">
  <div style="background:linear-gradient(135deg,#0b3d3a,#0f766e);padding:24px 28px;color:#ecfeff;">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.8;">Zouroboros · Operator Digest</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px;">${statusEmoji} ${esc(headline)}</div>
    <div style="font-size:13px;opacity:.85;margin-top:2px;">${esc(windowLabel)}</div>
  </div>
  <div style="padding:8px 28px 28px;">
    <div style="margin:16px 0;padding:14px 16px;background:${accent}0d;border-left:3px solid ${accent};border-radius:4px;font-size:14px;line-height:1.55;">${esc(bottomLine())}</div>
    ${scoreBadge ? `<div style="margin:0 0 8px;">${scoreBadge}</div>` : ""}
    ${section("What changed this week", changes.length ? list(changeItems) : `<p style="color:#6b7280;margin:6px 0;">No autonomous changes were applied. The loop observed but did not modify the system.</p>`)}
    ${healthItems.length ? section("Model health", list(healthItems)) : ""}
    ${section("Needs your judgment", needsJudgment ? list(judgmentItems) : `<p style="color:#6b7280;margin:6px 0;">Nothing is waiting on you.</p>`)}
    ${curiosityItems.length ? section("Open questions the system raised", `<p style="color:#6b7280;font-size:13px;margin:6px 0;">Hypotheses from the curiosity explorer — no action taken, ranked by potential payoff.</p>${list(curiosityItems)}`) : ""}
    ${repItems.length ? section("Verification layer", `<p style="color:#6b7280;font-size:13px;margin:6px 0;">Consensus gate ran ${reputation?.runs ?? "?"} times. Currently distrusted reviewers (zero weight):</p>${list(repItems)}`) : ""}
    ${section("Governance evidence", list(governanceItems))}
    <p style="margin-top:28px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px;">Generated ${new Date(NOW).toISOString().replace("T", " ").slice(0, 16)} UTC · read-only briefing · Alaric / Zouroboros loop.</p>
  </div>
</div></body></html>`;
}

// ── render pdf (try wkhtmltopdf → weasyprint → chromium) ──────────────────────────
function renderPdf(htmlPath: string, pdfPath: string): boolean {
  const attempts: [string, string[]][] = [
    ["wkhtmltopdf", ["--quiet", "--enable-local-file-access", htmlPath, pdfPath]],
    ["weasyprint", [htmlPath, pdfPath]],
    ["chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`]],
  ];
  for (const [bin, a] of attempts) {
    try {
      execFileSync(bin, a, { stdio: "ignore", timeout: 60_000 });
      if (existsSync(pdfPath)) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

// ── write outputs + manifest ─────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date(NOW).toISOString().slice(0, 10);
const mdPath = join(OUT_DIR, `operator-digest-${stamp}.md`);
const htmlPath = join(OUT_DIR, `operator-digest-${stamp}.html`);
const pdfPath = join(OUT_DIR, `operator-digest-${stamp}.pdf`);

writeFileSync(mdPath, renderMarkdown());
writeFileSync(htmlPath, renderHtml());
const pdfOk = MAKE_PDF ? renderPdf(htmlPath, pdfPath) : false;

const manifest = {
  status: level,
  subject: `${statusEmoji} Zouroboros Operator Digest — ${headline} (${stamp})`,
  summary: bottomLine(),
  windowLabel,
  mdPath,
  htmlPath,
  pdfPath: pdfOk ? pdfPath : null,
  changedCount: changes.length,
  needsJudgment,
  driftDetected,
  reverts,
  healthOk: level === "clear",
  governance,
};
console.log(JSON.stringify(manifest, null, 2));
