#!/usr/bin/env bun
/**
 * scorecard-report.ts — daily-report enrichment helper (ZBR "Synthesize Daily Memory")
 *
 * The [ZBR] Synthesize Daily Memory automation composes its report freehand. On healthy
 * days a 13-row 100%-scorecard carries no signal: a perfect score has no context, slow
 * drift is invisible until it crosses a threshold, and thin-sample perfect scores get
 * over-trusted. This helper turns the persisted per-run snapshots
 * (`<workspace>/.zo/selfheal/scorecard-*.json`, written by `introspect --store`) into the
 * three things the raw scorecard can't show:
 *
 *   1. TREND    — Δ composite vs the prior run + a 7-day composite band, and per-metric
 *                 Δvalue, so a 100% has context and slow drift is caught early.
 *   2. MARGIN   — direction-aware raw margin-to-target + a low-sample flag, so 1.00 on
 *                 n=3 (Routing) or a +0.007 margin (Eval-Integrity) isn't over-trusted.
 *   3. OPEN-ITEMS — deterministic watchlist: live-fact activation coverage and orphan
 *                 activation rows (measured live from the memory DB), the un-wired
 *                 capabilities (parsed from Wiring Health detail), plus regressions and
 *                 thin-sample perfect scores surfaced from the snapshot itself.
 *
 * Everything is derived from data already on disk / in the DB — no re-measurement, no
 * LLM. Direction is inferred per-metric from the snapshot (critical < target ⇒
 * higher_is_better), so no fragile static metric table is needed.
 *
 * Usage:
 *   bun packages/selfheal/scripts/scorecard-report.ts            # human-readable summary
 *   bun packages/selfheal/scripts/scorecard-report.ts --json     # structured JSON
 *   bun packages/selfheal/scripts/scorecard-report.ts --html     # HTML fragment for the email body
 *
 * Env (the automation already sets these):
 *   ZO_WORKSPACE / ZOUROBOROS_WORKSPACE   workspace root (snapshots live under .zo/selfheal)
 *   ZOUROBOROS_MEMORY_DB                  production memory DB (unified_activation lives here)
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WORKSPACE =
  process.env.ZO_WORKSPACE || process.env.ZOUROBOROS_WORKSPACE || '/home/workspace';
const SNAPSHOT_DIR = join(WORKSPACE, '.zo/selfheal');
const MEMORY_DB =
  process.env.ZOUROBOROS_MEMORY_DB ||
  process.env.ZO_MEMORY_DB ||
  join(WORKSPACE, '.zo/memory/shared-facts.db');

const EPS = 1e-6;
const LOW_SAMPLE_N = 10; // perfect score on fewer than this many observations = don't over-trust
const THIN_MARGIN_FRAC = 0.1; // margin < 10% of |target| = thin headroom
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface SnapMetric {
  name: string;
  value: number;
  target: number;
  critical: number;
  weight: number;
  score: number;
  status: string;
  trend: string;
  detail: string;
  recommendation: string;
}
interface Snapshot {
  timestamp: string;
  composite: number;
  metrics: SnapMetric[];
  weakest: string;
  _file: string;
  _mtime: number;
}

interface MetricReport {
  name: string;
  value: number;
  score: number;
  status: string;
  weight: number;
  direction: 'higher_is_better' | 'lower_is_better';
  marginToTarget: number; // raw units, positive = headroom on the good side of target
  marginFlag: 'below' | 'at' | 'thin' | 'ok';
  sample: number | null; // parsed from detail prose; null when no clear count
  lowSample: boolean;
  deltaValue: number | null; // vs prior run
  deltaScore: number | null;
  detail: string;
}

interface OpenItem {
  severity: 'high' | 'medium' | 'low';
  key: string;
  summary: string;
}

// ─── snapshot loading ────────────────────────────────────────────────────────

function loadSnapshots(): Snapshot[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith('scorecard-') && f.endsWith('.json'));
  const snaps: Snapshot[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), 'utf-8'));
      if (!raw || typeof raw.composite !== 'number' || !Array.isArray(raw.metrics)) continue;
      // scorecard-<ms>.json — the ms is a reliable sort key even if timestamp is odd
      const ms = Number(f.replace('scorecard-', '').replace('.json', '')) || Date.parse(raw.timestamp) || 0;
      snaps.push({ ...raw, _file: f, _mtime: ms });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  snaps.sort((a, b) => a._mtime - b._mtime); // ascending (oldest → newest)
  return snaps;
}

// ─── per-metric math ─────────────────────────────────────────────────────────

function direction(m: SnapMetric): 'higher_is_better' | 'lower_is_better' {
  // A metric is "lower is better" when its critical threshold sits ABOVE its target
  // (e.g. Eval Calibration target 0.15 / critical 0.25; Holdout target 14d / critical 28d).
  return m.critical < m.target ? 'higher_is_better' : 'lower_is_better';
}

function marginToTarget(m: SnapMetric): number {
  return direction(m) === 'higher_is_better' ? m.value - m.target : m.target - m.value;
}

function marginFlag(m: SnapMetric, margin: number): MetricReport['marginFlag'] {
  const thin = THIN_MARGIN_FRAC * Math.abs(m.target || 1);
  if (margin < -EPS) return 'below';
  if (Math.abs(margin) <= EPS) return 'at'; // on the line / on the floor (e.g. Episode Velocity)
  if (margin < thin) return 'thin';
  return 'ok';
}

// Parse an observation count out of the detail prose. Explicit patterns only — we would
// rather report "n/a" than mis-read "(58 orphans)" as a sample size.
function parseSample(detail: string): number | null {
  const patterns: RegExp[] = [
    /(\d+)\/(\d+)\s+(?:episodes?|evals?|invocations?|skill executions?|metrics?|capabilities)/i,
    /across\s+(\d+)\s+sampled/i,
    /(\d+)\s+sampled\s+episodes?/i,
    /(\d+)\s+collection/i,
    /(\d+)\s+replenished\s+case/i,
  ];
  for (const re of patterns) {
    const mm = detail.match(re);
    if (mm) return Number(mm[2] ?? mm[1]);
  }
  return null;
}

function buildMetricReports(current: Snapshot, prior: Snapshot | null): MetricReport[] {
  const priorByName = new Map<string, SnapMetric>();
  if (prior) for (const m of prior.metrics) priorByName.set(m.name, m);

  return current.metrics.map((m) => {
    const margin = marginToTarget(m);
    const sample = parseSample(m.detail);
    const p = priorByName.get(m.name);
    return {
      name: m.name,
      value: m.value,
      score: m.score,
      status: m.status,
      weight: m.weight,
      direction: direction(m),
      marginToTarget: margin,
      marginFlag: marginFlag(m, margin),
      sample,
      lowSample: m.score >= 0.999 && sample !== null && sample < LOW_SAMPLE_N,
      deltaValue: p ? m.value - p.value : null,
      deltaScore: p ? m.score - p.score : null,
      detail: m.detail,
    };
  });
}

// ─── open-items / watchlist ──────────────────────────────────────────────────

function unifiedActivationOpenItem(): OpenItem | null {
  if (!existsSync(MEMORY_DB)) return null;
  try {
    // bun:sqlite is only available under the bun runtime this script always runs in
    const { Database } = require('bun:sqlite');
    const db = new Database(MEMORY_DB, { readonly: true });
    try {
      const has = db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='unified_activation'`)
        .get();
      if (!has) return null;
      const now = Math.floor(Date.now() / 1000);
      const live = db
        .query(
          `SELECT COUNT(*) live_total,
                  SUM(CASE WHEN ua.fact_id IS NULL THEN 1 ELSE 0 END) missing,
                  SUM(CASE WHEN ua.fact_id IS NULL AND f.created_at < ? THEN 1 ELSE 0 END) overdue_missing,
                  SUM(CASE WHEN ua.fact_id IS NOT NULL AND ua.calculated_at < ? THEN 1 ELSE 0 END) stale,
                  MIN(CASE WHEN ua.fact_id IS NOT NULL THEN ua.calculated_at END) oldest,
                  MAX(CASE WHEN ua.fact_id IS NOT NULL THEN ua.calculated_at END) newest
             FROM facts f
             LEFT JOIN unified_activation ua ON ua.fact_id = f.id`
        )
        .get(now - 86400, now - 7 * 86400) as {
        live_total: number;
        missing: number;
        overdue_missing: number;
        stale: number;
        oldest: number | null;
        newest: number | null;
      };
      const orphan = db.query(
        `SELECT COUNT(*) count
           FROM unified_activation ua
           LEFT JOIN facts f ON f.id = ua.fact_id
          WHERE f.id IS NULL`
      ).get() as { count: number };
      if (!live || !live.live_total) return null;
      const staleLive = Number(live.stale || 0);
      const missingLive = Number(live.missing || 0);
      const overdueMissingLive = Number(live.overdue_missing || 0);
      const recentMissingLive = missingLive - overdueMissingLive;
      const orphanRows = Number(orphan?.count || 0);
      const coveredLive = live.live_total - missingLive;
      if (staleLive === 0 && overdueMissingLive === 0) {
        return {
          severity: 'low',
          key: 'unified_activation',
          summary:
            `unified_activation: ${coveredLive.toLocaleString()}/${live.live_total.toLocaleString()} live facts covered ` +
            `within 7d; ${recentMissingLive.toLocaleString()} recent live facts await the next daily recompute; ` +
            `${orphanRows.toLocaleString()} orphan activation rows require cleanup but do not indicate a recompute freeze.`,
        };
      }
      const stalePct = Math.round((staleLive / live.live_total) * 100);
      const oldestDate = live.oldest
        ? new Date(live.oldest * 1000).toISOString().slice(0, 10)
        : 'unknown';
      return {
        severity: 'medium',
        key: 'unified_activation',
        summary:
          `unified_activation live-fact coverage gap: ${overdueMissingLive.toLocaleString()} overdue missing, ` +
          `${recentMissingLive.toLocaleString()} recent pending, and ` +
          `${staleLive.toLocaleString()} stale of ${live.live_total.toLocaleString()} live facts (${stalePct}% stale; ` +
          `oldest ${oldestDate}); ${orphanRows.toLocaleString()} orphan activation rows are reported separately.`,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function unwiredCapabilitiesOpenItem(current: Snapshot): OpenItem | null {
  const wiring = current.metrics.find((m) => m.name === 'Wiring Health');
  if (!wiring) return null;
  const mm = wiring.detail.match(/un-?wired:\s*(.+)$/i);
  if (!mm) return null;
  const caps = mm[1]
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (caps.length === 0) return null;
  return {
    severity: 'low',
    key: 'unwired_capabilities',
    summary: `${caps.length} capability(ies) built but unreachable: ${caps.join('; ')}.`,
  };
}

function buildOpenItems(current: Snapshot, metrics: MetricReport[]): OpenItem[] {
  const items: OpenItem[] = [];

  const ua = unifiedActivationOpenItem();
  if (ua) items.push(ua);

  const unwired = unwiredCapabilitiesOpenItem(current);
  if (unwired) items.push(unwired);

  // Regressions: any optimized metric whose score dropped > 2% vs prior run.
  for (const m of metrics) {
    if (m.weight > 0 && m.deltaScore !== null && m.deltaScore < -0.02) {
      items.push({
        severity: 'high',
        key: `regression:${m.name}`,
        summary: `${m.name} regressed ${(m.deltaScore * 100).toFixed(1)}% vs prior run (score ${(m.score * 100).toFixed(0)}%).`,
      });
    }
  }

  // Non-healthy optimized metrics.
  for (const m of metrics) {
    if (m.weight > 0 && m.status !== 'HEALTHY') {
      items.push({
        severity: m.status === 'CRITICAL' ? 'high' : 'medium',
        key: `status:${m.name}`,
        summary: `${m.name} is ${m.status} — ${m.detail}`,
      });
    }
  }

  // Thin trust: perfect score on a low sample, or a thin/at-floor margin.
  const thin = metrics.filter(
    (m) => m.weight > 0 && (m.lowSample || m.marginFlag === 'thin' || m.marginFlag === 'at')
  );
  if (thin.length) {
    const parts = thin.map((m) => {
      const bits: string[] = [];
      if (m.lowSample) bits.push(`n=${m.sample}`);
      if (m.marginFlag === 'thin') bits.push(`margin +${m.marginToTarget.toFixed(3)}`);
      if (m.marginFlag === 'at') bits.push(`on target/floor`);
      return `${m.name} (${bits.join(', ')})`;
    });
    items.push({
      severity: 'low',
      key: 'thin_confidence',
      summary: `Perfect/near-perfect scores to treat with low confidence: ${parts.join('; ')}.`,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return items;
}

// ─── composite trend ─────────────────────────────────────────────────────────

function buildTrend(snaps: Snapshot[]) {
  const current = snaps[snaps.length - 1];
  const prior = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const cutoff = current._mtime - SEVEN_DAYS_MS;
  const window = snaps.filter((s) => s._mtime >= cutoff);
  const composites = window.map((s) => s.composite);
  return {
    current: current.composite,
    prior: prior ? prior.composite : null,
    deltaComposite: prior ? current.composite - prior.composite : null,
    window7dCount: window.length,
    min7d: composites.length ? Math.min(...composites) : current.composite,
    max7d: composites.length ? Math.max(...composites) : current.composite,
    series: window.map((s) => ({
      date: s.timestamp.slice(0, 10),
      composite: Number(s.composite.toFixed(4)),
    })),
  };
}

// ─── rendering ───────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function signed(n: number | null, digits = 3): string {
  if (n === null) return 'n/a';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}`;
}

function renderText(report: FullReport): string {
  const L: string[] = [];
  const t = report.trend;
  L.push('=== Composite Trend ===');
  L.push(
    `Composite ${pct(t.current)}  (Δ vs prior run: ${t.deltaComposite === null ? 'n/a' : signed(t.deltaComposite * 100, 2) + 'pp'})`
  );
  L.push(`7-day band: ${pct(t.min7d)} … ${pct(t.max7d)} over ${t.window7dCount} run(s)`);
  L.push('');
  L.push('=== Open Items / Watchlist ===');
  if (report.openItems.length === 0) L.push('(none)');
  for (const it of report.openItems) L.push(`[${it.severity.toUpperCase()}] ${it.summary}`);
  L.push('');
  L.push('=== Metrics (value | Δvalue | margin→target | sample) ===');
  for (const m of report.metrics) {
    const flag =
      m.marginFlag === 'below'
        ? ' BELOW'
        : m.marginFlag === 'at'
          ? ' AT/FLOOR'
          : m.marginFlag === 'thin'
            ? ' THIN'
            : '';
    const low = m.lowSample ? ' LOW-SAMPLE' : '';
    L.push(
      `${m.name.padEnd(24)} ${m.value.toFixed(3).padStart(7)} | Δ ${signed(m.deltaValue).padStart(7)} | ` +
        `${signed(m.marginToTarget).padStart(7)}${flag} | n=${m.sample ?? 'n/a'}${low}`
    );
  }
  return L.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(report: FullReport): string {
  const t = report.trend;
  const sevColor = { high: '#c0392b', medium: '#d68910', low: '#7f8c8d' } as const;
  const H: string[] = [];
  H.push(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#2c3e50">`);

  // Trend header
  const dc = t.deltaComposite;
  const dcStr =
    dc === null
      ? 'first run'
      : `${dc >= 0 ? '▲' : '▼'} ${signed(dc * 100, 2)}pp vs prior run`;
  H.push(
    `<p style="margin:0 0 4px"><strong>Composite Health:</strong> ${pct(t.current)} ` +
      `<span style="color:${dc !== null && dc < 0 ? '#c0392b' : '#27ae60'}">(${esc(dcStr)})</span></p>`
  );
  H.push(
    `<p style="margin:0 0 12px;color:#7f8c8d;font-size:12px">7-day band ${pct(t.min7d)} – ${pct(t.max7d)} across ${t.window7dCount} run(s)</p>`
  );

  // Open items — the lead section
  H.push(`<h3 style="margin:12px 0 6px;font-size:15px">Open Items &amp; Watchlist</h3>`);
  if (report.openItems.length === 0) {
    H.push(`<p style="margin:0;color:#27ae60">No open items — all clear.</p>`);
  } else {
    H.push(`<ul style="margin:0;padding-left:18px">`);
    for (const it of report.openItems) {
      H.push(
        `<li style="margin:0 0 4px"><span style="color:${sevColor[it.severity]};font-weight:600">[${it.severity.toUpperCase()}]</span> ${esc(it.summary)}</li>`
      );
    }
    H.push(`</ul>`);
  }

  // Full metric table (collapsed via <details> so healthy days stay lean; opens on demand / lives in PDF)
  H.push(`<details style="margin-top:12px"><summary style="cursor:pointer;font-size:15px;font-weight:600">Full Scorecard (${report.metrics.length} metrics)</summary>`);
  H.push(
    `<table style="border-collapse:collapse;margin-top:8px;font-size:12px;width:100%">` +
      `<tr style="background:#f4f6f7;text-align:left">` +
      `<th style="padding:4px 8px">Metric</th><th style="padding:4px 8px">Value</th>` +
      `<th style="padding:4px 8px">Δ vs prior</th><th style="padding:4px 8px">Margin→target</th>` +
      `<th style="padding:4px 8px">Sample</th><th style="padding:4px 8px">Status</th></tr>`
  );
  for (const m of report.metrics) {
    const flagTxt =
      m.marginFlag === 'below'
        ? ' <span style="color:#c0392b">below</span>'
        : m.marginFlag === 'at'
          ? ' <span style="color:#d68910">at/floor</span>'
          : m.marginFlag === 'thin'
            ? ' <span style="color:#d68910">thin</span>'
            : '';
    const sampleTxt = m.lowSample
      ? `<span style="color:#d68910">${m.sample} ⚠︎</span>`
      : `${m.sample ?? '—'}`;
    const dv = m.deltaValue;
    const dvTxt = dv === null ? '—' : `<span style="color:${dv < -0.001 ? '#c0392b' : dv > 0.001 ? '#27ae60' : '#7f8c8d'}">${signed(dv)}</span>`;
    H.push(
      `<tr style="border-top:1px solid #ecf0f1">` +
        `<td style="padding:4px 8px">${esc(m.name)}</td>` +
        `<td style="padding:4px 8px">${m.value.toFixed(3)}</td>` +
        `<td style="padding:4px 8px">${dvTxt}</td>` +
        `<td style="padding:4px 8px">${signed(m.marginToTarget)}${flagTxt}</td>` +
        `<td style="padding:4px 8px">${sampleTxt}</td>` +
        `<td style="padding:4px 8px">${esc(m.status)}</td></tr>`
    );
  }
  H.push(`</table></details>`);
  H.push(`</div>`);
  return H.join('\n');
}

// ─── main ────────────────────────────────────────────────────────────────────

interface FullReport {
  generatedAt: string;
  snapshotFile: string;
  priorSnapshotFile: string | null;
  trend: ReturnType<typeof buildTrend>;
  metrics: MetricReport[];
  openItems: OpenItem[];
}

function main() {
  const args = new Set(Bun.argv.slice(2));
  const snaps = loadSnapshots();
  if (snaps.length === 0) {
    console.error(`No scorecard snapshots found under ${SNAPSHOT_DIR}. Run introspect --store first.`);
    process.exit(1);
  }
  const current = snaps[snaps.length - 1];
  const prior = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const metrics = buildMetricReports(current, prior);
  const report: FullReport = {
    generatedAt: new Date().toISOString(),
    snapshotFile: current._file,
    priorSnapshotFile: prior ? prior._file : null,
    trend: buildTrend(snaps),
    metrics,
    openItems: buildOpenItems(current, metrics),
  };

  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (args.has('--html')) {
    console.log(renderHtml(report));
  } else {
    console.log(renderText(report));
  }
}

main();
