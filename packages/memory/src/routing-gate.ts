/**
 * A-Mem-style memory routing gate (M10 W4 t9).
 *
 * Inserts an explicit decision node before every unified memory query:
 * classifies the query as parametric / episodic / semantic / procedural and
 * persists the routing decision to `memory_routing_log` for downstream
 * analysis (which kinds dominate, which yield zero hits, where the hit-rate
 * imbalance is).
 *
 * v1: classify + log + delegate to existing search. Future iterations can
 * branch on `kind` to skip vector cost for parametric or hand off to
 * procedural search instead.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getMemoryDbPath } from 'zouroboros-core';
import { searchFactsHybrid } from './facts.js';
import type { MemorySearchResult } from 'zouroboros-core';

type MemoryConfig = import('zouroboros-core').MemoryConfig;

export type MemoryQueryKind =
  | 'parametric'
  | 'episodic'
  | 'semantic'
  | 'procedural';

export interface RoutingDecision {
  kind: MemoryQueryKind;
  confidence: number;
  reason: string;
}

export interface RouteOptions {
  limit?: number;
  vectorWeight?: number;
  rerank?: boolean;
  persona?: string;
  sessionId?: string;
}

function getDB(): string { return getMemoryDbPath(); }

const _ensuredPaths = new Set<string>();

/** Test-only: clear the ensure-table cache so the next call re-creates if missing. */
export function _resetRoutingGateCache(): void {
  _ensuredPaths.clear();
}

function ensureRoutingTable(): boolean {
  const db = getDB();
  if (_ensuredPaths.has(db)) return true;
  if (!existsSync(db)) return false;
  try {
    execSync(
      `sqlite3 "${db}" "` +
      `CREATE TABLE IF NOT EXISTS memory_routing_log (` +
      `id TEXT PRIMARY KEY, ` +
      `query TEXT NOT NULL, ` +
      `classified_kind TEXT NOT NULL CHECK(classified_kind IN ('parametric','episodic','semantic','procedural')), ` +
      `confidence REAL NOT NULL, ` +
      `reason TEXT, ` +
      `latency_ms INTEGER, ` +
      `hit_count INTEGER, ` +
      `persona TEXT, ` +
      `session_id TEXT, ` +
      `created_at INTEGER DEFAULT (strftime('%s','now'))` +
      `); ` +
      `CREATE INDEX IF NOT EXISTS idx_memory_routing_log_kind ON memory_routing_log(classified_kind, created_at DESC); ` +
      `CREATE INDEX IF NOT EXISTS idx_memory_routing_log_created ON memory_routing_log(created_at DESC);"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    _ensuredPaths.add(db);
    return true;
  } catch {
    return false;
  }
}

const PROCEDURAL_RX = /\b(how (to|do|can|should)|steps? (to|for)|procedure for|workflow for|process to|recipe for|guide to)\b/i;
const EPISODIC_RX = /\b(yesterday|last (week|month|time|year|night)|when (did|was)|what (happened|did we)|previous(ly)?|recent(ly)?|earlier|two days ago|today|this morning|this afternoon)\b/i;
const SEMANTIC_RX = /\b(who is|what is the|what are the|where is|definition of|email|address|phone|password|api key|version of|config(uration)? for)\b/i;

/**
 * Heuristic-only classifier (advisor's v1 directive — no LLM call on the hot path).
 * Returns the kind plus a confidence ∈ [0, 1] and a short reason string.
 */
export function classifyMemoryQuery(query: string): RoutingDecision {
  const q = (query || '').trim();
  if (!q) {
    return { kind: 'parametric', confidence: 0.4, reason: 'empty query' };
  }

  if (PROCEDURAL_RX.test(q)) {
    return { kind: 'procedural', confidence: 0.85, reason: 'how-to/steps pattern' };
  }
  if (EPISODIC_RX.test(q)) {
    return { kind: 'episodic', confidence: 0.85, reason: 'temporal/event pattern' };
  }
  if (SEMANTIC_RX.test(q)) {
    return { kind: 'semantic', confidence: 0.8, reason: 'fact-lookup pattern' };
  }

  // Fallback: very short generic queries → parametric (likely answerable
  // from model weights), longer entity-rich queries → semantic.
  const tokenCount = q.split(/\s+/).length;
  if (tokenCount <= 3 && !/[A-Z][a-z]/.test(q)) {
    return { kind: 'parametric', confidence: 0.55, reason: 'short generic query' };
  }
  return { kind: 'semantic', confidence: 0.5, reason: 'default semantic fallback' };
}

/**
 * Persist a routing decision. Best-effort — never throws.
 */
export function logMemoryRoute(
  query: string,
  decision: RoutingDecision,
  latencyMs: number,
  hitCount: number,
  persona?: string,
  sessionId?: string,
): void {
  if (!ensureRoutingTable()) return;
  try {
    const id = randomUUID();
    const safeQuery = query.replace(/'/g, "''").slice(0, 500);
    const safeReason = decision.reason.replace(/'/g, "''").slice(0, 200);
    const safePersona = (persona || '').replace(/'/g, "''").slice(0, 100);
    const safeSession = (sessionId || '').replace(/'/g, "''").slice(0, 100);
    execSync(
      `sqlite3 "${getDB()}" "` +
      `INSERT INTO memory_routing_log(id,query,classified_kind,confidence,reason,latency_ms,hit_count,persona,session_id) ` +
      `VALUES('${id}','${safeQuery}','${decision.kind}',${decision.confidence},'${safeReason}',${latencyMs},${hitCount},'${safePersona}','${safeSession}')"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
  } catch {
    // best-effort logging; never break the search path
  }
}

/**
 * Wrap searchFactsHybrid with the routing gate. Behaviour-preserving — same
 * results, plus a logged routing decision per call.
 *
 * Callers should prefer this over direct searchFactsHybrid() so all unified
 * memory queries pass through the gate.
 */
export async function routeMemoryQuery(
  query: string,
  config: MemoryConfig,
  options: RouteOptions = {},
): Promise<MemorySearchResult[]> {
  const decision = classifyMemoryQuery(query);
  const start = Date.now();
  const results = await searchFactsHybrid(query, config, {
    limit: options.limit,
    vectorWeight: options.vectorWeight,
    rerank: options.rerank,
    persona: options.persona,
  });
  const latency = Date.now() - start;
  logMemoryRoute(query, decision, latency, results.length, options.persona, options.sessionId);
  return results;
}

/**
 * Read recent routing log entries. Used by introspect telemetry + tests.
 */
export interface RoutingLogEntry {
  id: string;
  query: string;
  kind: MemoryQueryKind;
  confidence: number;
  reason: string;
  latencyMs: number;
  hitCount: number;
  persona: string;
  sessionId: string;
  createdAt: number;
}

export function getRecentRoutingDecisions(limit = 100): RoutingLogEntry[] {
  if (!ensureRoutingTable()) return [];
  try {
    const out = execSync(
      `sqlite3 -separator '|' "${getDB()}" "SELECT id,query,classified_kind,confidence,reason,latency_ms,hit_count,persona,session_id,created_at FROM memory_routing_log ORDER BY created_at DESC LIMIT ${limit}"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      const p = line.split('|');
      return {
        id: p[0] ?? '',
        query: p[1] ?? '',
        kind: (p[2] ?? 'semantic') as MemoryQueryKind,
        confidence: parseFloat(p[3] ?? '0') || 0,
        reason: p[4] ?? '',
        latencyMs: parseInt(p[5] ?? '0', 10) || 0,
        hitCount: parseInt(p[6] ?? '0', 10) || 0,
        persona: p[7] ?? '',
        sessionId: p[8] ?? '',
        createdAt: parseInt(p[9] ?? '0', 10) || 0,
      };
    });
  } catch {
    return [];
  }
}

export interface RoutingDistribution {
  total: number;
  byKind: Record<MemoryQueryKind, { count: number; avgHits: number; avgConfidence: number }>;
}

/**
 * Aggregate distribution stats — feeds the introspect scorecard later.
 */
export function getRoutingDistribution(sinceSeconds = 7 * 24 * 3600): RoutingDistribution {
  const empty: RoutingDistribution = {
    total: 0,
    byKind: {
      parametric: { count: 0, avgHits: 0, avgConfidence: 0 },
      episodic: { count: 0, avgHits: 0, avgConfidence: 0 },
      semantic: { count: 0, avgHits: 0, avgConfidence: 0 },
      procedural: { count: 0, avgHits: 0, avgConfidence: 0 },
    },
  };
  if (!ensureRoutingTable()) return empty;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
    const out = execSync(
      `sqlite3 -separator '|' "${getDB()}" "SELECT classified_kind, COUNT(*), AVG(hit_count), AVG(confidence) FROM memory_routing_log WHERE created_at >= ${cutoff} GROUP BY classified_kind"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (!out) return empty;
    let total = 0;
    for (const line of out.split('\n')) {
      const [kind, count, avgHits, avgConf] = line.split('|');
      const k = kind as MemoryQueryKind;
      if (k in empty.byKind) {
        const c = parseInt(count ?? '0', 10) || 0;
        total += c;
        empty.byKind[k] = {
          count: c,
          avgHits: parseFloat(avgHits ?? '0') || 0,
          avgConfidence: parseFloat(avgConf ?? '0') || 0,
        };
      }
    }
    empty.total = total;
    return empty;
  } catch {
    return empty;
  }
}
