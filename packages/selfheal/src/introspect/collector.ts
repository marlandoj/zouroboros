/**
 * Metric collection for introspection
 *
 * Fixes #47 (wrong script paths), #48 (wrong procedure query),
 * #49 (missing Skill Effectiveness), #50 (Episode Velocity = duplicate),
 * #51 (Graph Connectivity SQLite parse failure)
 */

import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { join } from 'path';
import { getMemoryDbPath, getWorkspaceRoot } from 'zouroboros-core';
import type { MetricResult, MetricStatus } from '../types.js';
import { scanWiring } from './wiring.js';
import {
  scoreEvalIntegrity,
  isoWeekKey,
  bankFreshness,
  FRESHNESS_STALE_DAYS,
  FRESHNESS_CRITICAL_DAYS,
} from './holdout.js';
import { scanMetricParity } from './parity.js';
import { persistRagHealthScore } from './rag-health-shadow.js';

const WORKSPACE = getWorkspaceRoot();

// Resolve the memory DB lazily at call time, not at module load. Capturing it in
// a module-level constant froze whatever ZOUROBOROS_MEMORY_DB was at first import
// — the original dual-DB footgun (ad-hoc runs silently bound to the legacy
// default) and a test-isolation hazard. Call-time resolution honors the env var
// set for the current process/run.
function memoryDb(): string {
  return getMemoryDbPath();
}

const EVAL_SCRIPT_CANDIDATES = [
  join(WORKSPACE, 'Skills/zo-memory-system/scripts/eval-continuation.ts'),
  join(WORKSPACE, 'zouroboros/packages/memory/scripts/self-enhance/eval-continuation.ts'),
];

const GRAPH_SCRIPT_CANDIDATES = [
  join(WORKSPACE, 'Skills/zo-memory-system/scripts/graph.ts'),
  join(WORKSPACE, '.zo/memory/scripts/graph.ts'),
];

function findScript(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface RunResult {
  stdout: string;
  ok: boolean;
  code: number;
}

function run(cmd: string, cwd?: string, timeout = 60000): RunResult {
  try {
    const stdout = execSync(cmd, {
      cwd: cwd || WORKSPACE,
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), ok: true, code: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout || '').toString().trim(),
      ok: false,
      code: e.status ?? 1,
    };
  }
}

function normalize(value: number, target: number, critical: number, inverted = false): number {
  if (inverted) {
    if (value <= target) return 1.0;
    if (value >= critical) return 0.0;
    return 1.0 - (value - target) / (critical - target);
  }
  if (value >= target) return 1.0;
  if (value <= critical) return 0.0;
  return (value - critical) / (target - critical);
}

function status(score: number): 'HEALTHY' | 'WARNING' | 'CRITICAL' {
  if (score >= 0.85) return 'HEALTHY';
  if (score >= 0.3) return 'WARNING';
  return 'CRITICAL';
}

function buildMetric(
  name: string,
  value: number,
  target: number,
  critical: number,
  weight: number,
  detail: string,
  recommendation: string,
  inverted = false,
  statusOverride?: MetricStatus
): MetricResult {
  const score = normalize(value, target, critical, inverted);
  return {
    name,
    value,
    target,
    critical,
    weight,
    score,
    status: statusOverride ?? status(score),
    trend: '—',
    detail,
    recommendation,
  };
}

// Native bun:sqlite read that mirrors the sqlite3 CLI output shape callers
// parse: columns joined by '|', rows joined by '\n', NULL rendered as ''.
function sqliteQuery(db: string, sql: string): string {
  if (!existsSync(db)) return '';
  let database: Database | null = null;
  try {
    database = new Database(db, { readonly: true });
    const rows = database.query(sql).values() as unknown[][];
    return rows
      .map(row => row.map(col => (col === null ? '' : String(col))).join('|'))
      .join('\n');
  } catch {
    return '';
  } finally {
    database?.close();
  }
}

// --- Metric Collectors ---

// The collectors are meaningless against the legacy default DB
// (~/.zouroboros/memory.db): its facts table is essentially empty (a single stray
// row) while the production shared-facts.db carries the full corpus. Running by
// hand without ZOUROBOROS_MEMORY_DB resolves the legacy default and misreports
// RAG/Chunk health as CRITICAL. Fail-closed per governance policy: when the
// resolved DB has a facts table but it holds fewer than MIN_VIABLE_FACTS rows,
// surface a loud operator-environment error instead of a false metric reading.
export const MIN_VIABLE_FACTS = 100;

// Returns true when the resolved DB exists, has a facts table, but that table is
// too sparse to be the production corpus — the signature of the legacy default.
// A DB with no facts table at all (fresh checkout) is NOT flagged here; the
// collectors already report that as 'not found / no data'.
export function isLegacyMemoryDb(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const has = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get();
    if (!has) return false;
    const r = db.query('SELECT COUNT(*) c FROM facts').get() as { c: number };
    return r.c < MIN_VIABLE_FACTS;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function legacyDbMetric(name: string, weight: number, target: number, critical: number): MetricResult {
  return buildMetric(name, 0, target, critical, weight,
    `LEGACY_MEMORY_DB: resolved DB has < ${MIN_VIABLE_FACTS} facts — this is the legacy default (~/.zouroboros/memory.db), not the production shared-facts.db`,
    'Set ZOUROBOROS_MEMORY_DB to the production memory DB before running the collector by hand',
    false,
    'INSUFFICIENT_EVIDENCE'
  );
}

export async function measureMemoryRecall(): Promise<MetricResult> {
  const evalScript = findScript(EVAL_SCRIPT_CANDIDATES);
  if (!evalScript) {
    return buildMetric('Memory Recall', 0.22, 0.90, 0.70, 0.25,
      'eval-continuation.ts not found in Skills/ or packages/',
      'Install zo-memory-system skill',
      false
    );
  }

  const result = run(`bun "${evalScript}" 2>&1`);
  const rateMatch = result.stdout.match(/Rate:\s*([\d.]+)%/);
  const passRate = rateMatch ? parseFloat(rateMatch[1]) / 100 : -1;

  if (passRate < 0) {
    const casesMatch = result.stdout.match(/Cases:\s*(\d+)/);
    const passedMatch = result.stdout.match(/Passed:\s*(\d+)/);
    if (casesMatch && passedMatch) {
      const cases = parseInt(casesMatch[1]);
      const passed = parseInt(passedMatch[1]);
      const rate = cases > 0 ? passed / cases : 0;
      return buildMetric('Memory Recall', rate, 0.90, 0.70, 0.25,
        `${passed}/${cases} fixtures passed (${(rate * 100).toFixed(1)}%)`,
        rate < 0.90
          ? 'Add continuation fixtures for missed cases; tune graph-boost weights'
          : 'Recall is healthy',
        false
      );
    }
    return buildMetric('Memory Recall', 0.25, 0.90, 0.70, 0.25,
      `Could not parse eval output: ${result.stdout.slice(0, 200)}`,
      'Check eval-continuation.ts output format',
      false
    );
  }

  return buildMetric('Memory Recall', passRate, 0.90, 0.70, 0.25,
    `${(passRate * 100).toFixed(1)}% fixture pass rate`,
    passRate < 0.90
      ? 'Add continuation fixtures for missed cases; tune graph-boost weights'
      : 'Recall is healthy',
    false
  );
}

export async function measureGraphConnectivity(): Promise<MetricResult> {
  const graphScript = findScript(GRAPH_SCRIPT_CANDIDATES);

  if (graphScript) {
    const result = run(`bun "${graphScript}" knowledge-gaps 2>&1`);
    const linkedMatch = result.stdout.match(/Linked facts:\s*(\d+)\s*\(([\d.]+)%\)/);
    const orphanMatch = result.stdout.match(/Orphan facts:\s*(\d+)/);

    if (linkedMatch) {
      const linkedPct = parseFloat(linkedMatch[2]) / 100;
      const orphanCount = orphanMatch ? parseInt(orphanMatch[1]) : 0;
      return buildMetric('Graph Connectivity', linkedPct, 0.80, 0.60, 0.15,
        `${(linkedPct * 100).toFixed(1)}% linked (${orphanCount} orphans)`,
        linkedPct < 0.80
          ? `Link ${orphanCount} orphan facts; run wikilink auto-capture`
          : 'Graph connectivity is healthy',
        false
      );
    }
  }

  if (existsSync(memoryDb())) {
    const totalStr = sqliteQuery(memoryDb(), 'SELECT COUNT(*) FROM facts');
    const linkedStr = sqliteQuery(memoryDb(),
      'SELECT COUNT(DISTINCT source_id) + COUNT(DISTINCT target_id) FROM fact_links');
    const total = parseInt(totalStr) || 0;
    const linked = parseInt(linkedStr) || 0;
    if (total > 0) {
      const ratio = Math.min(linked / total, 1.0);
      return buildMetric('Graph Connectivity', ratio, 0.80, 0.60, 0.15,
        `${linked}/${total} facts have graph links (${(ratio * 100).toFixed(1)}%)`,
        ratio < 0.80
          ? 'Run wikilink auto-capture on orphan entities'
          : 'Graph connectivity is healthy',
        false
      );
    }
  }

  return buildMetric('Graph Connectivity', 0.14, 0.80, 0.60, 0.15,
    'No graph data available',
    'Install zo-memory-system skill',
    false
  );
}

export async function measureRoutingAccuracy(): Promise<MetricResult> {
  if (existsSync(memoryDb())) {
    // Count 'resolved' as non-failure: resolved = contradiction resolved normally, not a routing error.
    // Only 'failed' outcomes indicate actual routing problems. Exclude 'ongoing' from the denominator.
    const result = sqliteQuery(memoryDb(),
      "SELECT COUNT(*), SUM(CASE WHEN outcome IN ('success','resolved') THEN 1 ELSE 0 END) FROM episodes WHERE created_at > strftime('%s','now','-7 days') AND outcome != 'ongoing'");
    const parts = result.split('|');
    if (parts.length >= 2) {
      const total = parseInt(parts[0]) || 0;
      const nonFailed = parseInt(parts[1]) || 0;
      const rate = total > 0 ? nonFailed / total : 0;
      return buildMetric('Routing Accuracy', rate, 0.85, 0.70, 0.20,
        `${nonFailed}/${total} episodes non-failed (${(rate * 100).toFixed(1)}%) over 7 days`,
        rate < 0.85
          ? 'Review failed episodes for routing mismatches'
          : 'Routing accuracy is healthy',
        false
      );
    }
  }
  return buildMetric('Routing Accuracy', 0, 0.85, 0.70, 0.20,
    'No episode data available',
    'Ensure episodes are being recorded to memory DB',
    false
  );
}

export async function measureEvalCalibration(): Promise<MetricResult> {
  const evalDir = join(WORKSPACE, '.zo/evaluations');
  if (existsSync(evalDir)) {
    const result = run(`find "${evalDir}" -name "*.json" -mtime -14 -exec grep -l '"stage3Override": true' {} \\; | wc -l`);
    const overrideResult = run(`find "${evalDir}" -name "*.json" -mtime -14 | wc -l`);
    const overrides = parseInt(result.stdout) || 0;
    const total = parseInt(overrideResult.stdout) || 0;
    const rate = total > 0 ? overrides / total : 0;
    return buildMetric('Eval Calibration', rate, 0.15, 0.25, 0.15,
      `${overrides}/${total} evals had Stage 3 overrides (${(rate * 100).toFixed(1)}%)`,
      rate > 0.15
        ? 'High override rate — review mechanical/semantic checks for false positives'
        : 'Override rate is within acceptable range',
      true
    );
  }
  return buildMetric('Eval Calibration', 0, 0.15, 0.25, 0.15,
    'No evaluation data found',
    'Run evaluations to establish calibration baseline',
    true
  );
}

export async function measureProcedureFreshness(): Promise<MetricResult> {
  // Freshness = execution quality (success rate), not recency.
  // A procedure used infrequently but successfully is healthy, not stale.
  // Only procedures that have been invoked at least once are evaluated.
  if (existsSync(memoryDb())) {
    const result = sqliteQuery(memoryDb(),
      'SELECT COUNT(*), SUM(success_count), SUM(success_count + failure_count) FROM procedures WHERE (success_count + failure_count) > 0');
    const parts = result.split('|');
    if (parts.length >= 3) {
      const executedTotal = parseInt(parts[0]) || 0;
      const totalSuccess = parseInt(parts[1]) || 0;
      const totalInvocations = parseInt(parts[2]) || 0;

      if (executedTotal === 0 || totalInvocations === 0) {
        const totalStr = sqliteQuery(memoryDb(), 'SELECT COUNT(*) FROM procedures');
        const total = parseInt(totalStr) || 0;
        return buildMetric('Procedure Freshness', 1.0, 0.80, 0.50, 0.15,
          `${total} procedure(s) defined with no execution history — quality not applicable`,
          'Procedures exist but have not been invoked; not stale',
          false
        );
      }

      const successRate = totalSuccess / totalInvocations;
      return buildMetric('Procedure Freshness', successRate, 0.80, 0.50, 0.15,
        `${executedTotal} procedure(s) with execution history; ${totalSuccess}/${totalInvocations} invocations successful (${Math.round(successRate * 100)}%)`,
        successRate < 0.80
          ? `${totalInvocations - totalSuccess} failed invocations — investigate failing procedures`
          : 'Procedure execution quality is healthy',
        false
      );
    }
  }
  return buildMetric('Procedure Freshness', 1.0, 0.80, 0.50, 0.15,
    'No procedure data available',
    'Ensure procedures are stored in memory DB',
    false
  );
}

export async function measureEpisodeVelocity(): Promise<MetricResult> {
  if (existsSync(memoryDb())) {
    const currentStr = sqliteQuery(memoryDb(),
      "SELECT COUNT(*), SUM(CASE WHEN outcome IN ('success','resolved') THEN 1 ELSE 0 END) FROM episodes WHERE created_at > strftime('%s','now','-7 days') AND outcome != 'ongoing'");
    const priorStr = sqliteQuery(memoryDb(),
      "SELECT COUNT(*), SUM(CASE WHEN outcome IN ('success','resolved') THEN 1 ELSE 0 END) FROM episodes WHERE created_at > strftime('%s','now','-14 days') AND created_at <= strftime('%s','now','-7 days') AND outcome != 'ongoing'");

    const cur = currentStr.split('|');
    const prev = priorStr.split('|');

    if (cur.length >= 2 && prev.length >= 2) {
      const curTotal = parseInt(cur[0]) || 0;
      const curSuccess = parseInt(cur[1]) || 0;
      const prevTotal = parseInt(prev[0]) || 0;
      const prevSuccess = parseInt(prev[1]) || 0;

      const curRate = curTotal > 0 ? curSuccess / curTotal : 0;
      const prevRate = prevTotal > 0 ? prevSuccess / prevTotal : 0;
      const delta = curRate - prevRate;
      const trendIcon = delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '→';

      const velocityScore = 0.5 + delta;
      return buildMetric('Episode Velocity', velocityScore, 0.50, -0.20, 0.10,
        `${(curRate * 100).toFixed(1)}% current vs ${(prevRate * 100).toFixed(1)}% prior 7d ${trendIcon}`,
        delta < 0
          ? 'Investigate declining success rate in recent episodes'
          : 'Episode velocity is healthy — success rate trending up',
        false
      );
    }
  }
  return buildMetric('Episode Velocity', 0, 0.50, -0.20, 0.10,
    'No episode data available',
    'Ensure episodes are being recorded',
    false
  );
}

// ---------------------------------------------------------------------------
// RAG Health (t1 — M10 Self-Enhancement Instrumentation)
// Measures faithfulness of the memory retrieval layer using an LLM-as-judge
// approach inspired by RAGAS. Samples recent episodes, retrieves top-k
// context facts via FTS, then asks gpt-4o-mini to score faithfulness (0-1).
// Score = mean faithfulness across sampled episodes.
// ---------------------------------------------------------------------------

type GenerateFn = (opts: {
  prompt: string;
  system?: string;
  workload: 'gate' | 'extraction' | 'summarization' | 'briefing';
}) => Promise<{ content: string; cost_usd?: number }>;

async function loadGenerator(): Promise<GenerateFn | null> {
  try {
    const specifier = ['..', '..', '..', 'memory', 'src', 'standalone', 'model-client.js'].join('/');
    const mod: any = await import(specifier);
    return mod.generate as GenerateFn;
  } catch {
    return null;
  }
}

async function scoreFaithfulness(
  generate: GenerateFn,
  episode: string,
  contexts: string[]
): Promise<number | null> {
  if (contexts.length === 0) return null;
  const ctxBlock = contexts.map((c, i) => `[${i + 1}] ${c}`).join('\n');
  const prompt = `You are a RAG faithfulness evaluator.

CONTEXT FACTS:
${ctxBlock}

EPISODE SUMMARY:
${episode}

Task: Score how faithfully the episode summary is grounded in the context facts above.
- 1.0 = all claims in the summary are directly supported by the context
- 0.5 = some claims are supported, some are not
- 0.0 = claims contradict or ignore the context entirely

Respond with ONLY a number between 0.0 and 1.0. No explanation.`;

  const result = await generate({ prompt, workload: 'gate' });
  const score = parseFloat(result.content.trim());
  return isNaN(score) ? null : Math.min(1, Math.max(0, score));
}

const RAG_HEALTH_SAMPLE_SIZE = 10;

export function loadRagHealthEpisodes(dbPath: string): Array<{ id: string; text: string }> {
  const episodeRows = sqliteQuery(dbPath,
    `SELECT e.id, substr(d.text, 1, instr(d.text||char(10), char(10))-1) FROM episodes e JOIN episode_documents d ON d.episode_id = e.id WHERE e.outcome='success' AND d.text NOT LIKE 'Conversation capture%' AND d.text NOT LIKE 'Zouroboros introspection scorecard%' AND d.text NOT LIKE 'Zouroboros evolution%' ORDER BY e.created_at DESC LIMIT ${RAG_HEALTH_SAMPLE_SIZE}`
  );

  if (!episodeRows || !episodeRows.includes('|')) return [];

  return episodeRows.split('\n').filter(Boolean).map(row => {
    const pipe = row.indexOf('|');
    return { id: row.slice(0, pipe), text: row.slice(pipe + 1).slice(0, 500) };
  }).filter(episode => episode.text.length > 20).slice(0, RAG_HEALTH_SAMPLE_SIZE);
}

// Read back the persisted rag_health_score history (newest first) so the metric
// can alert on a 3-run moving average instead of single-run flapping.
export function loadRagHealthScoreHistory(dbPath: string, limit = 3): number[] {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.query(
      `SELECT value FROM facts WHERE key='rag_health_score' ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as Array<{ value: string }>;
    return rows
      .map(row => parseFloat(row.value))
      .filter(score => !isNaN(score));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export async function measureRAGHealth(): Promise<MetricResult> {
  if (!existsSync(memoryDb())) {
    return buildMetric('RAG Health', 0, 0.80, 0.60, 0.15,
      'Memory DB not found',
      'Ensure memory DB is initialised',
      false
    );
  }

  if (isLegacyMemoryDb(memoryDb())) return legacyDbMetric('RAG Health', 0.15, 0.80, 0.60);

  const generate = await loadGenerator();
  if (!generate) {
    return buildMetric('RAG Health', 0.5, 0.80, 0.60, 0.15,
      'LLM client unavailable — faithfulness not measurable',
      'Ensure ZO_OPENAI_API_KEY is set',
      false
    );
  }

  // Sample up to N recent episodes that have text.
  // Exclude synthetic pipeline summaries with no evaluable user-facing claims
  // (conversation captures, introspection scorecards, evolution/test_coverage
  // telemetry); they distort both faithfulness sampling and cohort diversity.
  // Extract only the first line of text (the human-readable summary) via SQL
  // so embedded newlines in the text field don't corrupt the row-per-line
  // parser below (entity-tag and JSON continuation lines would otherwise be
  // treated as separate pseudo-episodes with garbage FTS tokens).
  const episodes = loadRagHealthEpisodes(memoryDb());

  if (episodes.length === 0) {
    return buildMetric('RAG Health', 0.5, 0.80, 0.60, 0.15,
      'INSUFFICIENT_EVIDENCE: episode documents are not evaluable',
      'Capture episode summaries before interpreting RAG faithfulness',
      false,
      'INSUFFICIENT_EVIDENCE'
    );
  }

  const scores: number[] = [];
  let insufficientEpisodes = 0;
  for (const ep of episodes) {
    // Retrieve top-3 context facts via FTS — strip FTS5 metacharacters (colons,
    // slashes, dots etc. cause silent column-scope or syntax errors) and join
    // with OR so partial matches still return context.
    // Use ORDER BY rank (BM25) so the most semantically relevant facts surface
    // first instead of arbitrary insertion-order results.
    const tokens = ep.text.split(/\s+/).slice(0, 5)
      .map(w => w.replace(/[^\w]/g, ''))
      .filter(w => w.length > 2);
    const keyword = tokens.length > 0 ? tokens.join(' OR ') : '';
    const ftsResult = keyword ? sqliteQuery(memoryDb(),
      `SELECT f.value FROM facts_fts ff JOIN facts f ON f.rowid = ff.rowid WHERE facts_fts MATCH '${keyword}' ORDER BY rank LIMIT 3`
    ) : '';
    const contexts = ftsResult
      ? ftsResult.split('\n').filter(Boolean).map(r => r.slice(0, 300))
      : [];

    try {
      const score = await scoreFaithfulness(generate, ep.text, contexts);
      if (score === null) insufficientEpisodes++;
      else scores.push(score);
    } catch {
      // skip this episode on LLM error
    }
  }

  if (scores.length === 0) {
    return buildMetric('RAG Health', 0.5, 0.80, 0.60, 0.15,
      `INSUFFICIENT_EVIDENCE: no judge scores across ${episodes.length} sampled episodes`,
      'Check retrieval context and judge output before interpreting faithfulness',
      false,
      'INSUFFICIENT_EVIDENCE'
    );
  }

  const faithfulness = scores.reduce((a, b) => a + b, 0) / scores.length;

  let persistenceFailure: string | null = null;
  try {
    persistRagHealthScore(memoryDb(), faithfulness);
  } catch (error) {
    persistenceFailure = error instanceof Error ? error.message : String(error);
    console.error(`[rag-health] metric persistence failed: ${persistenceFailure}`);
  }

  // 3-run moving average (includes the score just persisted) smooths single-run
  // judge noise; alert only when the smoothed trend drops below 0.70.
  const history = loadRagHealthScoreHistory(memoryDb(), 3);
  const movingAverage = history.length > 0
    ? history.reduce((a, b) => a + b, 0) / history.length
    : faithfulness;
  const trendAlert = history.length >= 3 && movingAverage < 0.70;

  const perEpisode = scores.map(s => s.toFixed(2)).join(',');

  return buildMetric('RAG Health', faithfulness, 0.80, 0.60, 0.15,
    `Faithfulness: ${(faithfulness * 100).toFixed(1)}% across ${scores.length} sampled episodes` +
      ` (per-episode: ${perEpisode}; 3-run avg ${(movingAverage * 100).toFixed(1)}%)` +
      (insufficientEpisodes > 0 ? `; ${insufficientEpisodes} episode(s) lacked evaluable evidence` : '') +
      (trendAlert ? '; TREND_ALERT: 3-run moving average below 0.70' : '') +
      (persistenceFailure ? `; PERSISTENCE_FAILED: ${persistenceFailure}` : ''),
    persistenceFailure
      ? 'Repair RAG metric persistence before the governor consumes this score'
      : trendAlert
      ? 'Sustained low faithfulness across 3 runs — investigate retrieval drift, not single-run noise'
      : faithfulness < 0.80
      ? 'Low faithfulness — retrieved facts may not match episode claims; tune retrieval'
      : 'RAG faithfulness is healthy',
    false
  );
}

/**
 * Chunk Health (M10 W4 t10) — reads chunk_quality table populated by
 * `score-chunk-quality.ts`. Uses the most recent measurement per
 * collection and averages mean ICC + mean DCC.
 *
 * Target: combined ≥ 0.55  (DCC ≈ 0.6, ICC ≈ 0.5 in healthy corpora)
 * Critical: combined ≤ 0.30
 */
// Collections excluded from the chunk-health composite. code-docs is a store of
// atomic, independent SDK reference snippets (one point per snippet, no
// chunk_index, no sequential document flow). The ICC/DCC consecutive-chunk
// cohesion metric is semantically inapplicable there — it ends up measuring
// cosine similarity between unrelated code snippets that happen to share a
// source filename, which reads low (0.416) by construction, not by bad chunking.
// Including it drags the composite below target through a measurement artifact.
const CHUNK_HEALTH_EXCLUDED_COLLECTIONS = new Set(['code-docs']);

export async function measureChunkHealth(): Promise<MetricResult> {
  if (!existsSync(memoryDb())) {
    return buildMetric('Chunk Health', 0, 0.55, 0.30, 0.08,
      'Memory DB not found',
      'Initialise memory DB and run score-chunk-quality.ts',
      false
    );
  }

  if (isLegacyMemoryDb(memoryDb())) return legacyDbMetric('Chunk Health', 0.08, 0.55, 0.30);

  const tableCheck = sqliteQuery(memoryDb(),
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_quality'");
  if (!tableCheck.includes('chunk_quality')) {
    return buildMetric('Chunk Health', 0, 0.55, 0.30, 0.08,
      'chunk_quality table missing — never scored',
      'Run: bun packages/selfheal/scripts/score-chunk-quality.ts',
      false
    );
  }

  // Latest measurement per collection (within 14 days), then average across.
  // Snippet-store collections (see CHUNK_HEALTH_EXCLUDED_COLLECTIONS) are
  // excluded because consecutive-chunk cohesion is not meaningful for them.
  const rows = sqliteQuery(memoryDb(),
    "SELECT collection, AVG(icc), AVG(dcc), COUNT(*) FROM chunk_quality " +
    "WHERE measured_at > strftime('%s','now','-14 days') " +
    "GROUP BY collection"
  );

  if (!rows) {
    return buildMetric('Chunk Health', 0, 0.55, 0.30, 0.08,
      'No recent chunk_quality rows (last 14d)',
      'Schedule weekly score-chunk-quality.ts run',
      false
    );
  }

  const lines = rows.split('\n').filter(Boolean);
  let totalICC = 0;
  let totalDCC = 0;
  let collectionsWithData = 0;
  const excluded: string[] = [];
  for (const line of lines) {
    const [collection, iccStr, dccStr, countStr] = line.split('|');
    if (collection && CHUNK_HEALTH_EXCLUDED_COLLECTIONS.has(collection)) {
      excluded.push(collection);
      continue;
    }
    const icc = parseFloat(iccStr ?? '');
    const dcc = parseFloat(dccStr ?? '');
    const count = parseInt(countStr ?? '0', 10) || 0;
    if (count > 0 && (!isNaN(icc) || !isNaN(dcc))) {
      totalICC += isNaN(icc) ? 0 : icc;
      totalDCC += isNaN(dcc) ? 0 : dcc;
      collectionsWithData++;
    }
  }

  if (collectionsWithData === 0) {
    return buildMetric('Chunk Health', 0, 0.55, 0.30, 0.08,
      'chunk_quality has rows but no parseable ICC/DCC',
      'Re-run score-chunk-quality.ts; verify Qdrant points carry vectors',
      false
    );
  }

  const meanICC = totalICC / collectionsWithData;
  const meanDCC = totalDCC / collectionsWithData;
  const combined = (meanICC + meanDCC) / 2;

  return buildMetric('Chunk Health', combined, 0.55, 0.30, 0.08,
    `ICC ${meanICC.toFixed(3)} / DCC ${meanDCC.toFixed(3)} across ${collectionsWithData} collection(s)` +
      (excluded.length ? `; excluded snippet-store(s): ${excluded.join(', ')}` : ''),
    combined < 0.55
      ? 'Tune chunking — boundaries may be cutting mid-thought; consider semantic pre-segmentation'
      : 'Chunk cohesion is healthy',
    false
  );
}

export async function measureSkillEffectiveness(): Promise<MetricResult> {
  if (existsSync(memoryDb())) {
    const tableCheck = sqliteQuery(memoryDb(),
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_executions'");
    if (tableCheck.includes('skill_executions')) {
      const result = sqliteQuery(memoryDb(),
        "SELECT COUNT(*), SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) FROM skill_executions WHERE created_at > strftime('%s','now','-7 days')");
      const parts = result.split('|');
      if (parts.length >= 2) {
        const total = parseInt(parts[0]) || 0;
        const successes = parseInt(parts[1]) || 0;
        if (total > 0) {
          const rate = successes / total;
          return buildMetric('Skill Effectiveness', rate, 0.85, 0.70, 0.10,
            `${successes}/${total} skill executions succeeded (${(rate * 100).toFixed(1)}%) over 7 days`,
            rate < 0.85
              ? 'Analyze failing skills for error patterns'
              : 'Skill effectiveness is healthy',
            false
          );
        }
      }
    }
  }
  return buildMetric('Skill Effectiveness', 1.0, 0.85, 0.70, 0.10,
    'No skill execution data (assuming healthy)',
    'Instrument skills with execution tracking',
    false
  );
}

// --- Anti-Goodhart + Wiring signals (seed-antigoodhart-wiring-2026-06-01) ---

/**
 * Eval-Integrity — display-only anti-Goodhart tripwire (weight 0).
 *
 * Reports point-in-time agreement between the reserved held-out partition and the
 * visible partition of holdout-fixtures.json. It is intentionally NOT a member of
 * MultiMetricOptimizer.targets (multi-metric.ts) so surfacing it never creates an
 * incentive to game it (Goodhart). Weight 0 keeps it out of the composite. Fail-safe
 * to 1.0 (dormant) when the hidden bank is unmeasurable so a missing runner never
 * fabricates drift.
 */
export async function measureEvalIntegrity(): Promise<MetricResult> {
  let report;
  try {
    report = scoreEvalIntegrity();
  } catch {
    report = null;
  }

  if (!report) {
    return buildMetric('Eval-Integrity', 1.0, 0.85, 0.60, 0,
      `Held-out bank unmeasurable (epoch ${isoWeekKey()}) — tripwire dormant`,
      'Install bun + continuation module to activate the anti-Goodhart tripwire',
      false
    );
  }

  const { agreement, heldFrac, visibleFrac, heldCount, visibleCount } = report;
  return buildMetric('Eval-Integrity', agreement, 0.85, 0.60, 0,
    `held ${(heldFrac * 100).toFixed(0)}% (${heldCount}) vs visible ${(visibleFrac * 100).toFixed(0)}% (${visibleCount}); agreement ${(agreement * 100).toFixed(0)}%`,
    agreement < 0.85
      ? 'Visible and held-out partitions diverge — visible recall may be over-fit; review before trusting recall gains'
      : 'Visible and held-out evals agree',
    false
  );
}

/**
 * Wiring Health — score = wired/declared capabilities from the Wiring Sentinel
 * (wiring.ts). Detail lists the top un-wired capabilities for the human; this is a
 * report-and-escalate signal (never auto-deletes). Fail-safe to 1.0 when the scan
 * cannot run so a sentinel failure never blocks the loop.
 */
export async function measureWiringHealth(): Promise<MetricResult> {
  let report;
  try {
    report = scanWiring();
  } catch (e: any) {
    return buildMetric('Wiring Health', 1.0, 0.80, 0.50, 0.12,
      `Wiring scan unavailable: ${String(e?.message ?? e).slice(0, 80)}`,
      'Investigate Wiring Sentinel failure (TS compiler API / src not reachable)',
      false
    );
  }

  const { declared, wired, findings } = report;
  const value = declared > 0 ? wired / declared : 1.0;

  const unwired = findings.filter((f) => f.kind !== 'broken_path_ref');
  const brokenRefs = findings.filter((f) => f.kind === 'broken_path_ref');
  const topUnwired = unwired.slice(0, 3).map((f) => `${f.symbol} (${f.kind})`).join('; ');

  const detail =
    declared === 0
      ? 'No declared capabilities found to check'
      : `${wired}/${declared} capabilities wired` +
        (topUnwired ? ` — un-wired: ${topUnwired}` : '') +
        (brokenRefs.length ? ` — ${brokenRefs.length} broken path ref(s)` : '');

  return buildMetric('Wiring Health', value, 0.80, 0.50, 0.12,
    detail,
    value < 0.80 || brokenRefs.length > 0
      ? 'Wire or retire un-invoked capabilities; fix broken path refs (report-and-escalate, never auto-delete)'
      : 'Wiring is healthy',
    false
  );
}

/**
 * Eval-Production Parity — display-only metric-surface parity tripwire (weight 0).
 *
 * Diffs the production scorecard surface (these buildMetric declarations) against the
 * optimizer objective (multi-metric.ts) via the static parity scanner. A metric on one
 * surface but not the other — the ZouroBench inflation class where retrieval capabilities
 * lived only in the benchmark adapter — surfaces here with file:line evidence. Weight 0
 * (display-only, never an optimizer target, exactly like Eval-Integrity) so the loop can
 * never be incentivised to game the parity of its own metric surface. Fail-safe to 1.0
 * (dormant) when the scan cannot run so a parser failure never fabricates divergence.
 */
export async function measureEvalProductionParity(): Promise<MetricResult> {
  let report;
  try {
    report = scanMetricParity();
  } catch (e: any) {
    return buildMetric('Eval-Production Parity', 1.0, 0.85, 0.60, 0,
      `Parity scan unavailable: ${String(e?.message ?? e).slice(0, 80)}`,
      'Investigate parity scanner (TS compiler API / source not reachable)',
      false
    );
  }

  const { declared, aligned, findings } = report;
  const value = declared > 0 ? aligned / declared : 1.0;
  const top = findings.slice(0, 3).map((f) => `${f.metric} (${f.kind})`).join('; ');

  const detail =
    findings.length === 0
      ? `${aligned}/${declared} metrics aligned across production + optimizer surfaces`
      : `${findings.length} surface divergence(s): ${top}` +
        (findings.length > 3 ? ` +${findings.length - 3} more` : '') +
        ` — ${findings[0].evidence}`;

  return buildMetric('Eval-Production Parity', value, 0.85, 0.60, 0,
    detail,
    findings.length > 0
      ? 'Reconcile the metric surfaces or record the divergence in parity-manifest.json (the scorecard and the optimizer must grade the same metric set)'
      : 'Production and optimizer metric surfaces agree',
    false
  );
}

/**
 * Holdout Freshness — display-only staleness tripwire (weight 0) for the anti-Goodhart
 * held-out bank (ZOU-279). A fixed examiner is eventually memorizable even though the
 * optimizer never reads it; replenishment mints fresh cases from recent real
 * continuations. This surfaces how long since the last mint so a stalled refresh
 * schedule is visible. Weight 0 (exactly like Eval-Integrity / Eval-Production Parity)
 * keeps the examiner OUT of the optimization loop — it can never become a target.
 * Fail-safe to 1.0 (dormant) when seed-only or unmeasurable so a fresh checkout never
 * false-flags. Inverted: small age = fresh, large age = stale.
 */
export async function measureHoldoutFreshness(): Promise<MetricResult> {
  let f;
  try {
    f = bankFreshness();
  } catch {
    f = null;
  }

  if (!f || f.replenishedCount === 0 || f.ageDays === null) {
    return buildMetric('Holdout Freshness', 0, FRESHNESS_STALE_DAYS, FRESHNESS_CRITICAL_DAYS, 0,
      f
        ? `Seed-only bank (${f.seedCaseCount} synthetic cases) — replenishment not yet run`
        : 'Held-out bank freshness unmeasurable',
      'Schedule standalone/holdout-replenish.ts so the hidden examiner draws from recent real continuations',
      true
    );
  }

  return buildMetric('Holdout Freshness', f.ageDays, FRESHNESS_STALE_DAYS, FRESHNESS_CRITICAL_DAYS, 0,
    `${f.replenishedCount} replenished case(s); newest minted ${f.ageDays.toFixed(1)}d ago (stale > ${FRESHNESS_STALE_DAYS}d)`,
    f.stale
      ? 'Held-out bank is stale — re-run the replenishment job so the optimizer cannot memorize a fixed examiner'
      : 'Held-out bank is fresh',
    true
  );
}
