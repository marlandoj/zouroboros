export type RetrievalMode = "vector-only" | "graph-only" | "federated";
export type EvidenceSource = "memory" | "code";
export type EvidenceSignal = "vector" | "graph";

export interface TemporalProvenance {
  observed_at: string;
  valid_from?: string;
  valid_to?: string;
  supersedes: string[];
  superseded_by?: string;
  status: "current" | "superseded" | "expired";
}

export interface RetrievalHit {
  id: string;
  source: EvidenceSource;
  signal: EvidenceSignal;
  title: string;
  content: string;
  score: number;
  hop?: number;
  relation?: string;
  location?: string;
  temporal?: Partial<TemporalProvenance>;
  metadata?: Record<string, unknown>;
}

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  signals: EvidenceSignal[];
  title: string;
  content: string;
  score: number;
  hop: 0 | 1;
  relation?: string;
  location?: string;
  temporal: TemporalProvenance;
  metadata: Record<string, unknown>;
}

export interface EvidenceEnvelope {
  schema: "zouroboros.evidence.v1";
  query: string;
  route: {
    requested: RetrievalMode | "auto";
    selected: RetrievalMode;
    reason: string;
  };
  constraints: {
    max_hops: 1;
    limit: number;
  };
  evidence: EvidenceItem[];
  stats: {
    candidates: number;
    returned: number;
    expanded: number;
    by_source: Record<EvidenceSource, number>;
    by_signal: Record<EvidenceSignal, number>;
  };
}

export interface FederatedBackend {
  vectorSearch(source: EvidenceSource, query: string, limit: number): Promise<RetrievalHit[]>;
  graphSearch(source: EvidenceSource, query: string, limit: number): Promise<RetrievalHit[]>;
  expandOneHop(source: EvidenceSource, seeds: RetrievalHit[], limit: number): Promise<RetrievalHit[]>;
}

export interface FederatedQuery {
  query: string;
  mode?: RetrievalMode | "auto";
  limit?: number;
  expand?: boolean;
}

const FEDERATED_RX = /\b(supersed(?:e|ed|ing)|current(?:ly)?|latest|history|temporal|provenance|decision.*(?:code|implement)|(?:code|implement).*(?:decision|memory))\b/i;
const GRAPH_RX = /\b(callers?|callees?|imports?|depends?|dependency|related|relationship|path|trace|graph|connected|who calls|where used)\b/i;

export function routeFederatedQuery(query: string, requested: RetrievalMode | "auto" = "auto") {
  if (requested !== "auto") {
    return { selected: requested, reason: "explicit mode override" } as const;
  }
  if (FEDERATED_RX.test(query)) {
    return { selected: "federated", reason: "cross-source or temporal evidence requested" } as const;
  }
  if (GRAPH_RX.test(query)) {
    return { selected: "graph-only", reason: "structural relationship query" } as const;
  }
  return { selected: "vector-only", reason: "semantic recall query" } as const;
}

function iso(value: string | undefined, fallback: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeTemporal(hit: RetrievalHit, observedAt: string): TemporalProvenance {
  const validFrom = iso(hit.temporal?.valid_from, observedAt);
  const validTo = iso(hit.temporal?.valid_to, observedAt);
  const supersededBy = hit.temporal?.superseded_by;
  const expired = validTo ? new Date(validTo).getTime() <= new Date(observedAt).getTime() : false;
  return {
    observed_at: iso(hit.temporal?.observed_at, observedAt) ?? observedAt,
    valid_from: validFrom,
    valid_to: validTo,
    supersedes: [...(hit.temporal?.supersedes ?? [])].sort(),
    superseded_by: supersededBy,
    status: supersededBy ? "superseded" : expired ? "expired" : "current",
  };
}

function compareEvidence(a: EvidenceItem, b: EvidenceItem): number {
  const statusRank = (item: EvidenceItem) => item.temporal.status === "current" ? 0 : 1;
  return statusRank(a) - statusRank(b)
    || b.score - a.score
    || a.hop - b.hop
    || a.source.localeCompare(b.source)
    || a.id.localeCompare(b.id);
}

export async function retrieveFederated(
  input: FederatedQuery,
  backend: FederatedBackend,
  now: () => Date = () => new Date(),
): Promise<EvidenceEnvelope> {
  const query = input.query.trim();
  if (!query) throw new Error("query must not be empty");
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
  const requested = input.mode ?? "auto";
  const route = routeFederatedQuery(query, requested);
  const sources: EvidenceSource[] = ["memory", "code"];
  const candidateLimit = Math.min(100, Math.max(limit * 2, 10));
  const batches: RetrievalHit[][] = [];

  if (route.selected !== "graph-only") {
    batches.push(...await Promise.all(sources.map(source => backend.vectorSearch(source, query, candidateLimit))));
  }
  if (route.selected !== "vector-only") {
    batches.push(...await Promise.all(sources.map(source => backend.graphSearch(source, query, candidateLimit))));
  }

  const direct = batches.flat().map(hit => ({ ...hit, hop: 0 as const }));
  let expanded: RetrievalHit[] = [];
  if (input.expand !== false && route.selected !== "vector-only" && direct.length > 0) {
    const expansionBatches = await Promise.all(sources.map(source => {
      const seeds = direct.filter(hit => hit.source === source).slice(0, Math.min(5, limit));
      return seeds.length === 0 ? Promise.resolve([]) : backend.expandOneHop(source, seeds, candidateLimit);
    }));
    expanded = expansionBatches.flat()
      .filter(hit => (hit.hop ?? 1) <= 1)
      .map(hit => ({ ...hit, hop: 1 as const, score: hit.score * 0.85 }));
  }

  const observedAt = now().toISOString();
  const merged = new Map<string, EvidenceItem>();
  for (const hit of [...direct, ...expanded]) {
    const key = `${hit.source}:${hit.id}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.signals.includes(hit.signal)) existing.signals.push(hit.signal);
      existing.signals.sort();
      existing.score = Math.max(existing.score, hit.score) + 0.025;
      existing.hop = Math.min(existing.hop, hit.hop ?? 0) as 0 | 1;
      existing.metadata = { ...existing.metadata, ...hit.metadata };
      continue;
    }
    merged.set(key, {
      id: hit.id,
      source: hit.source,
      signals: [hit.signal],
      title: hit.title,
      content: hit.content,
      score: Math.max(0, Math.min(1, hit.score)),
      hop: Math.min(1, Math.max(0, hit.hop ?? 0)) as 0 | 1,
      relation: hit.relation,
      location: hit.location,
      temporal: normalizeTemporal(hit, observedAt),
      metadata: hit.metadata ?? {},
    });
  }

  const evidence = [...merged.values()].sort(compareEvidence).slice(0, limit);
  const bySource: Record<EvidenceSource, number> = { memory: 0, code: 0 };
  const bySignal: Record<EvidenceSignal, number> = { vector: 0, graph: 0 };
  for (const item of evidence) {
    bySource[item.source]++;
    for (const signal of item.signals) bySignal[signal]++;
  }

  return {
    schema: "zouroboros.evidence.v1",
    query,
    route: { requested, selected: route.selected, reason: route.reason },
    constraints: { max_hops: 1, limit },
    evidence,
    stats: {
      candidates: direct.length + expanded.length,
      returned: evidence.length,
      expanded: expanded.length,
      by_source: bySource,
      by_signal: bySignal,
    },
  };
}
