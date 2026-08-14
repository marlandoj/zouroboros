import { Database } from "bun:sqlite";
import type {
  EvidenceSource,
  FederatedBackend,
  RetrievalHit,
  TemporalProvenance,
} from "./federated-retrieval.js";

const DEFAULT_CODEBASE_CLI = "/home/workspace/Integrations/codebase-memory-mcp/bin/codebase-memory-mcp";

interface ProductionBackendOptions {
  dbPath: string;
  memoryCli(args: string[]): Promise<string>;
  codeProject?: string;
  codebaseCli?: string;
}

interface FactRow {
  id: string;
  entity: string;
  key: string | null;
  value: string;
  source: string | null;
  created_at: number;
  metadata: string | null;
  confidence: number | null;
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function unixIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : undefined;
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function provenanceFor(db: Database, factId: string, createdAt: number, metadata: Record<string, unknown>): Partial<TemporalProvenance> {
  let row: Record<string, unknown> | null = null;
  if (tableExists(db, "fact_provenance")) {
    row = db.query(`
      SELECT source, captured_at, superseded_by, effective_from, effective_until, metadata
      FROM fact_provenance
      WHERE fact_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(factId) as Record<string, unknown> | null;
  }
  const rowMetadata = safeJson(typeof row?.metadata === "string" ? row.metadata : null);
  const supersedes = metadata.supersedes ?? rowMetadata.supersedes;
  return {
    observed_at: unixIso(row?.captured_at) ?? unixIso(createdAt),
    valid_from: unixIso(row?.effective_from) ?? unixIso(createdAt),
    valid_to: unixIso(row?.effective_until),
    supersedes: Array.isArray(supersedes) ? supersedes.filter((item): item is string => typeof item === "string") : [],
    superseded_by: typeof row?.superseded_by === "string" ? row.superseded_by : undefined,
  };
}

function factToHit(db: Database, row: FactRow, signal: "vector" | "graph", score: number): RetrievalHit {
  const metadata = safeJson(row.metadata);
  return {
    id: row.id,
    source: "memory",
    signal,
    title: `${row.entity}.${row.key ?? "_"}`,
    content: row.value,
    score,
    location: `memory://${row.entity}/${row.key ?? "_"}`,
    temporal: provenanceFor(db, row.id, row.created_at, metadata),
    metadata: {
      ...metadata,
      origin: row.source ?? "unknown",
      confidence: row.confidence ?? 1,
    },
  };
}

function openDb(path: string): Database {
  return new Database(path, { readonly: true });
}

function findFact(db: Database, title: string): FactRow | null {
  const separator = title.lastIndexOf(".");
  const entity = separator > 0 ? title.slice(0, separator) : title;
  const key = separator > 0 ? title.slice(separator + 1) : null;
  return db.query(`
    SELECT id, entity, key, value, source, created_at, metadata, confidence
    FROM facts
    WHERE entity = ? AND (key = ? OR (? IS NULL AND key IS NULL))
    ORDER BY created_at DESC
    LIMIT 1
  `).get(entity, key, key) as FactRow | null;
}

function parseMemoryVectorOutput(output: string, dbPath: string, limit: number): RetrievalHit[] {
  const lines = output.split("\n");
  const hits: RetrievalHit[] = [];
  const db = openDb(dbPath);
  try {
    for (let index = 0; index < lines.length && hits.length < limit; index++) {
      const match = lines[index].match(/^\[[^\]]+\]\s+(.+?)\s+=\s+(.*)$/);
      if (!match) continue;
      const scoreLine = lines.slice(index + 1, index + 4).find(line => /score:\s*[0-9.]+/.test(line));
      const rawScore = Number(scoreLine?.match(/score:\s*([0-9.]+)/)?.[1] ?? 0);
      const row = findFact(db, match[1].trim());
      if (row) {
        hits.push(factToHit(db, row, "vector", Math.max(0, Math.min(1, rawScore))));
      } else {
        hits.push({
          id: match[1].trim(), source: "memory", signal: "vector",
          title: match[1].trim(), content: match[2].trim(), score: Math.max(0, Math.min(1, rawScore)),
          metadata: { parser: "memory-cli" },
        });
      }
    }
  } finally {
    db.close();
  }
  return hits;
}

function memoryGraphSeeds(dbPath: string, query: string, limit: number): RetrievalHit[] {
  const db = openDb(dbPath);
  try {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])].slice(0, 8);
    if (terms.length === 0) return [];
    const fts = terms.map(term => `"${term.replace(/"/g, "")}"`).join(" OR ");
    let rows: FactRow[] = [];
    if (tableExists(db, "facts_fts")) {
      rows = db.query(`
        SELECT f.id, f.entity, f.key, f.value, f.source, f.created_at, f.metadata, f.confidence
        FROM facts_fts
        JOIN facts f ON f.rowid = facts_fts.rowid
        WHERE facts_fts MATCH ?
          AND (f.expires_at IS NULL OR f.expires_at > strftime('%s', 'now'))
        ORDER BY bm25(facts_fts), f.importance DESC
        LIMIT ?
      `).all(fts, limit) as FactRow[];
    }
    return rows.map((row, index) => factToHit(db, row, "graph", 1 / (index + 1)));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function expandMemory(dbPath: string, seeds: RetrievalHit[], limit: number): RetrievalHit[] {
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, "fact_links")) return [];
    const hits: RetrievalHit[] = [];
    const seen = new Set(seeds.map(seed => seed.id));
    for (const seed of seeds) {
      const rows = db.query(`
        SELECT f.id, f.entity, f.key, f.value, f.source, f.created_at, f.metadata, f.confidence,
               links.relation, links.weight
        FROM (
          SELECT target_id AS neighbor_id, relation, weight FROM fact_links WHERE source_id = ?
          UNION ALL
          SELECT source_id AS neighbor_id, relation, weight FROM fact_links WHERE target_id = ?
        ) links
        JOIN facts f ON f.id = links.neighbor_id
        WHERE (f.expires_at IS NULL OR f.expires_at > strftime('%s', 'now'))
        ORDER BY links.weight DESC, f.importance DESC
        LIMIT ?
      `).all(seed.id, seed.id, limit) as Array<FactRow & { relation: string; weight: number }>;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        hits.push({ ...factToHit(db, row, "graph", Math.min(1, row.weight || 0.5)), hop: 1, relation: row.relation });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

async function runCodebaseTool(binary: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([binary, "cli", tool, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`codebase-memory ${tool} failed: ${stderr.trim() || stdout.trim()}`);
  const jsonLine = stdout.split("\n").reverse().find(line => line.trim().startsWith("{"));
  if (!jsonLine) throw new Error(`codebase-memory ${tool} returned no JSON`);
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

function codeHits(payload: Record<string, unknown>, signal: "vector" | "graph", limit: number): RetrievalHit[] {
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.slice(0, limit).map((value, index) => {
    const row = value as Record<string, unknown>;
    const qualifiedName = String(row.qualified_name ?? row.node ?? `result-${index}`);
    const file = typeof row.file === "string" ? row.file : undefined;
    return {
      id: qualifiedName,
      source: "code" as const,
      signal,
      title: String(row.node ?? qualifiedName),
      content: Array.isArray(row.match_lines)
        ? `${qualifiedName} matches at lines ${row.match_lines.join(", ")}`
        : qualifiedName,
      score: 1 / (index + 1),
      location: file ? `${file}:${String(row.start_line ?? 1)}` : undefined,
      temporal: { observed_at: new Date().toISOString(), supersedes: [] },
      metadata: { label: row.label, start_line: row.start_line, end_line: row.end_line },
    };
  });
}

async function searchCode(binary: string, project: string, query: string, signal: "vector" | "graph", limit: number): Promise<RetrievalHit[]> {
  const stopWords = new Set(["about", "after", "before", "could", "from", "have", "into", "latest", "memory", "that", "their", "there", "these", "this", "what", "where", "which", "with"]);
  const terms = [...new Set(query.toLowerCase().match(/[a-z_][a-z0-9_-]{3,}/g) ?? [])]
    .filter(term => !stopWords.has(term))
    .slice(0, 8);
  const pattern = terms.length > 0 ? terms.join("|") : query;
  const payload = await runCodebaseTool(binary, "search_code", {
    project,
    pattern,
    regex: terms.length > 1,
    mode: "compact",
    max_results: limit,
  });
  return codeHits(payload, signal, limit);
}

async function expandCode(binary: string, project: string, seeds: RetrievalHit[], limit: number): Promise<RetrievalHit[]> {
  const hits: RetrievalHit[] = [];
  for (const seed of seeds) {
    const payload = await runCodebaseTool(binary, "trace_path", {
      project,
      function_name: seed.id,
      direction: "both",
      depth: 1,
    });
    for (const direction of ["callers", "callees"] as const) {
      const rows = Array.isArray(payload[direction]) ? payload[direction] as Array<Record<string, unknown>> : [];
      for (const row of rows) {
        if (Number(row.hop ?? 1) > 1) continue;
        hits.push({
          id: String(row.qualified_name ?? row.name), source: "code", signal: "graph",
          title: String(row.name ?? row.qualified_name), content: String(row.qualified_name ?? row.name),
          score: 0.75, hop: 1, relation: direction === "callers" ? "called-by" : "calls",
          metadata: { seed: seed.id },
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

export function createProductionFederatedBackend(options: ProductionBackendOptions): FederatedBackend {
  const binary = options.codebaseCli ?? DEFAULT_CODEBASE_CLI;
  const project = options.codeProject ?? "home-workspace-packages";
  return {
    async vectorSearch(source: EvidenceSource, query: string, limit: number) {
      if (source === "code") return searchCode(binary, project, query, "vector", limit);
      const output = await options.memoryCli(["hybrid", query, `--limit=${limit}`, "--no-hyde", "--no-graph"]);
      return parseMemoryVectorOutput(output, options.dbPath, limit);
    },
    async graphSearch(source: EvidenceSource, query: string, limit: number) {
      return source === "code"
        ? searchCode(binary, project, query, "graph", limit)
        : memoryGraphSeeds(options.dbPath, query, limit);
    },
    async expandOneHop(source: EvidenceSource, seeds: RetrievalHit[], limit: number) {
      return source === "code"
        ? expandCode(binary, project, seeds, limit)
        : expandMemory(options.dbPath, seeds, limit);
    },
  };
}
