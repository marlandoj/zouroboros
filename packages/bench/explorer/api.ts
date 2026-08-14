/**
 * ZouroBench Results Explorer — GET-only read API (ZBRE-003 / ZOU-831).
 *
 * Pure `Request → Response` handler over an {@link ArtifactStore}. No route
 * ever builds a filesystem path from request input: identifiers are validated
 * and then looked up only in the in-memory index. Every mutation method
 * returns 405; malformed or unknown filters return structured 400 errors.
 */

import {
  isSafeArtifactId,
  type ArtifactStore,
  type LoadedRun,
  type StoreIndex,
} from "./artifact-store";

// ── Structured errors ─────────────────────────────────────────────────

export type ApiErrorCode =
  | "method_not_allowed"
  | "unknown_route"
  | "invalid_id"
  | "run_not_found"
  | "run_invalid"
  | "unknown_filter"
  | "malformed_filter"
  | "missing_filter"
  | "page_size_too_large"
  | "page_out_of_range";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function errorResponse(error: ApiError, extraHeaders?: Record<string, string>): Response {
  return Response.json(
    { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } },
    { status: error.status, headers: extraHeaders },
  );
}

// ── Query validation ──────────────────────────────────────────────────

type ParamParser = (value: string, name: string) => unknown;

function malformed(name: string, value: string, expected: string): ApiError {
  return new ApiError(400, "malformed_filter", `filter "${name}" is malformed: expected ${expected}`, {
    filter: name,
    value: value.slice(0, 100),
  });
}

const parseIntParam =
  (min: number, max: number): ParamParser =>
  (value, name) => {
    if (!/^\d{1,9}$/.test(value)) throw malformed(name, value, `an integer between ${min} and ${max}`);
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
      if (name === "page_size" && parsed > max) {
        throw new ApiError(400, "page_size_too_large", `page_size ${parsed} exceeds the maximum of ${max}`, {
          filter: name,
          maximum: max,
        });
      }
      throw malformed(name, value, `an integer between ${min} and ${max}`);
    }
    return parsed;
  };

const parseBoolParam: ParamParser = (value, name) => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw malformed(name, value, `"true" or "false"`);
};

/**
 * Evidenced booleans are tri-state: "unknown" selects rows whose legacy
 * artifacts never recorded the field. "true"/"false" match only explicit
 * evidence — absence is ambiguous, never false.
 */
const parseTriStateParam: ParamParser = (value, name) => {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "unknown") return null;
  throw malformed(name, value, `"true", "false", or "unknown"`);
};

/** Strict ISO-8601: date, optional time, optional Z/offset — nothing else. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const parseIsoDateParam: ParamParser = (value, name) => {
  if (value.length > 40 || !ISO_8601.test(value) || !Number.isFinite(Date.parse(value))) {
    throw malformed(name, value, "an ISO-8601 date/time");
  }
  return value;
};

const parseSchemaVersionParam: ParamParser = (value, name) => {
  if (value === "1" || value === "2") return Number(value) as 1 | 2;
  throw malformed(name, value, `"1" or "2"`);
};

const parseIdParam: ParamParser = (value, name) => {
  if (!isSafeArtifactId(value)) throw malformed(name, value, "a safe artifact id");
  return value;
};

const parseStringParam =
  (maxLength: number): ParamParser =>
  (value, name) => {
    if (value.length === 0 || value.length > maxLength) {
      throw malformed(name, value, `a non-empty string of at most ${maxLength} characters`);
    }
    return value;
  };

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const PAGINATION_PARAMS: Record<string, ParamParser> = {
  page: parseIntParam(1, 1_000_000),
  page_size: parseIntParam(1, MAX_PAGE_SIZE),
};

/**
 * Strict query parsing: unknown parameters are rejected, repeated parameters
 * are rejected, and each value must parse. Fail-closed by construction.
 */
function parseQuery(url: URL, allowed: Record<string, ParamParser>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams.entries()) {
    if (!(name in allowed)) {
      throw new ApiError(400, "unknown_filter", `unknown filter "${name}"`, {
        filter: name,
        allowed: Object.keys(allowed).sort(),
      });
    }
    if (seen.has(name)) throw malformed(name, value, "a single value (parameter repeated)");
    seen.add(name);
    out[name] = allowed[name](value, name);
  }
  return out;
}

/**
 * Unpaginated lists embedded in a payload are deterministically bounded:
 * `total` is always the full count and `truncated` flags any cut — loud,
 * never silent.
 */
export const EMBED_LIMIT = 1000;

function embedList<T>(items: T[]): { total: number; truncated: boolean; items: T[] } {
  return { total: items.length, truncated: items.length > EMBED_LIMIT, items: items.slice(0, EMBED_LIMIT) };
}

interface Page {
  page: number;
  page_size: number;
}

function pageOf(params: Record<string, unknown>): Page {
  return {
    page: (params.page as number | undefined) ?? 1,
    page_size: (params.page_size as number | undefined) ?? DEFAULT_PAGE_SIZE,
  };
}

/**
 * Collection routes materialize matching rows before slicing: row counts are
 * bounded by the on-disk corpus (never by request input), the response size
 * is capped by MAX_PAGE_SIZE, and totals require the full filtered count
 * anyway. The per-request scan cost itself is documented and budgeted in
 * ArtifactStore.getIndex.
 */
function paginate<T>(items: T[], page: Page): { pagination: object; items: T[] } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / page.page_size));
  if (page.page > totalPages) {
    throw new ApiError(400, "page_out_of_range", `page ${page.page} exceeds total_pages ${totalPages}`, {
      page: page.page,
      total_pages: totalPages,
    });
  }
  const start = (page.page - 1) * page.page_size;
  return {
    pagination: {
      page: page.page,
      page_size: page.page_size,
      total_items: total,
      total_pages: totalPages,
    },
    items: items.slice(start, start + page.page_size),
  };
}

// ── Route helpers ─────────────────────────────────────────────────────

function requireRun(store: ArtifactStore, index: StoreIndex, id: string): LoadedRun {
  if (!isSafeArtifactId(id)) {
    throw new ApiError(400, "invalid_id", "artifact ids may not contain path separators or dot segments", {
      id: id.slice(0, 100),
    });
  }
  const run = store.getRun(id);
  if (!run) {
    const invalid = index.invalid.find((entry) => entry.kind === "runs" && entry.id === id);
    if (invalid) {
      throw new ApiError(409, "run_invalid", `run artifact "${id}" is invalid and cannot be served`, {
        reasons: invalid.reasons,
      });
    }
    throw new ApiError(404, "run_not_found", `run "${id}" is not in the artifact index`);
  }
  return run;
}

interface QuestionRow {
  run: string;
  run_timestamp: string;
  question_id: string;
  question_type: string;
  category: string;
  correct: boolean;
  retrieval_ms: number;
  answer_ms: number;
  judge_label: string | null;
  consensus_invoked: boolean | null;
  consensus_verdict: string | null;
  consensus_confidence: number | null;
}

function questionRows(run: LoadedRun): QuestionRow[] {
  return run.run.questions.map((q) => ({
    run: run.summary.id,
    run_timestamp: run.summary.timestamp,
    question_id: q.question_id,
    question_type: q.question_type,
    category: q.category,
    correct: q.correct,
    retrieval_ms: q.retrieval_ms,
    answer_ms: q.answer_ms,
    judge_label: q.judge_label.value,
    consensus_invoked: q.consensus_invoked.value,
    consensus_verdict: q.consensus_verdict.value,
    consensus_confidence: q.consensus_confidence.value,
  }));
}

const QUESTION_FILTERS: Record<string, ParamParser> = {
  ...PAGINATION_PARAMS,
  run: parseIdParam,
  category: parseStringParam(200),
  type: parseStringParam(200),
  correct: parseBoolParam,
  consensus_invoked: parseTriStateParam,
};

function filterQuestions(rows: QuestionRow[], params: Record<string, unknown>): QuestionRow[] {
  return rows.filter((row) => {
    if (params.category !== undefined && row.category !== params.category) return false;
    if (params.type !== undefined && row.question_type !== params.type) return false;
    if (params.correct !== undefined && row.correct !== params.correct) return false;
    if ("consensus_invoked" in params && row.consensus_invoked !== params.consensus_invoked) {
      return false;
    }
    return true;
  });
}

function runsInOrder(index: StoreIndex): LoadedRun[] {
  return index.runOrder
    .map((id) => index.runs.get(id))
    .filter((run): run is LoadedRun => run !== undefined);
}

function meanOf(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return Math.round((finite.reduce((sum, v) => sum + v, 0) / finite.length) * 100) / 100;
}

// ── Handler ───────────────────────────────────────────────────────────

export function handleExplorerRequest(store: ArtifactStore, req: Request): Response {
  const url = new URL(req.url);

  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    return errorResponse(new ApiError(400, "invalid_id", "request path is not decodable"));
  }

  if (segments[0] !== "api") {
    return errorResponse(new ApiError(404, "unknown_route", "only /api/* routes are served"));
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return errorResponse(
      new ApiError(405, "method_not_allowed", `${req.method} is not allowed: this API is read-only`),
      { Allow: "GET, HEAD" },
    );
  }

  try {
    const body = route(store, segments.slice(1), url);
    const response = Response.json(body.payload, {
      headers: { "X-Index-Fingerprint": body.fingerprint, "Cache-Control": "no-store" },
    });
    if (req.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    console.error("explorer api internal error:", error);
    return Response.json(
      { error: { code: "internal_error", message: "unexpected error serving read-only artifact data" } },
      { status: 500 },
    );
  }
}

function route(
  store: ArtifactStore,
  parts: string[],
  url: URL,
): { payload: unknown; fingerprint: string } {
  const index = store.getIndex();
  const fingerprint = index.fingerprint;
  const [head, second, third, ...rest] = parts;

  if (rest.length > 0 || head === undefined) {
    throw new ApiError(404, "unknown_route", `no such API route: /api/${parts.join("/")}`);
  }

  switch (head) {
    case "health": {
      if (second !== undefined) break;
      parseQuery(url, {});
      return {
        payload: {
          status: "ok",
          index_fingerprint: fingerprint,
          generated_at: new Date().toISOString(),
          roots: index.roots,
          totals: {
            valid_runs: index.runs.size,
            invalid_artifacts: index.invalid.length,
            baselines: index.baselines.length,
            cohorts: index.cohorts.length,
            parity: index.parity.length,
          },
          index_stats: index.stats,
        },
        fingerprint,
      };
    }

    case "runs": {
      if (second === undefined) {
        const params = parseQuery(url, {
          ...PAGINATION_PARAMS,
          benchmark: parseStringParam(200),
          dataset: parseStringParam(400),
          schema_version: parseSchemaVersionParam,
          from: parseIsoDateParam,
          to: parseIsoDateParam,
        });
        const filtered = runsInOrder(index).filter((run) => {
          const s = run.summary;
          if (params.benchmark !== undefined && s.benchmark !== params.benchmark) return false;
          if (params.dataset !== undefined && s.dataset !== params.dataset) return false;
          if (params.schema_version !== undefined && s.schema_version !== params.schema_version) return false;
          if (params.from !== undefined || params.to !== undefined) {
            const epoch = Date.parse(s.timestamp);
            // A run whose timestamp cannot be placed on the timeline can
            // never honestly match a time window.
            if (!Number.isFinite(epoch)) return false;
            if (params.from !== undefined && epoch < Date.parse(params.from as string)) return false;
            if (params.to !== undefined && epoch > Date.parse(params.to as string)) return false;
          }
          return true;
        });
        const { pagination, items } = paginate(
          filtered.map((run) => run.summary),
          pageOf(params),
        );
        return {
          payload: {
            pagination,
            items,
            invalid: embedList(index.invalid.filter((entry) => entry.kind === "runs")),
          },
          fingerprint,
        };
      }
      if (third === undefined) {
        parseQuery(url, {});
        const run = requireRun(store, index, second);
        return {
          payload: { summary: run.summary, run: run.run, warnings: run.warnings },
          fingerprint,
        };
      }
      if (third === "questions") {
        const params = parseQuery(url, QUESTION_FILTERS);
        if (params.run !== undefined) {
          throw new ApiError(400, "malformed_filter", `filter "run" is not allowed on a run-scoped route`, {
            filter: "run",
          });
        }
        const run = requireRun(store, index, second);
        const rows = filterQuestions(questionRows(run), params);
        const { pagination, items } = paginate(rows, pageOf(params));
        return { payload: { pagination, items, run: run.summary.id }, fingerprint };
      }
      break;
    }

    case "questions": {
      if (second !== undefined) break;
      const params = parseQuery(url, QUESTION_FILTERS);
      let sourceRuns: LoadedRun[];
      if (params.run !== undefined) {
        sourceRuns = [requireRun(store, index, params.run as string)];
      } else {
        sourceRuns = runsInOrder(index);
      }
      const rows = filterQuestions(sourceRuns.flatMap(questionRows), params);
      const { pagination, items } = paginate(rows, pageOf(params));
      return { payload: { pagination, items }, fingerprint };
    }

    case "reliability": {
      if (second !== undefined) break;
      parseQuery(url, {});
      const aggregate = store.getAggregate();
      const series = runsInOrder(index)
        .map((run) => ({
          run: run.summary.id,
          timestamp: run.summary.timestamp,
          schema_version: run.summary.schema_version,
          overall_accuracy: run.summary.overall_accuracy,
          total_questions: run.summary.totals.total_questions,
          answered: run.summary.totals.answered,
        }))
        .reverse();
      return { payload: { aggregate, series: embedList(series) }, fingerprint };
    }

    case "compare": {
      if (second !== undefined) break;
      const params = parseQuery(url, { run_a: parseIdParam, run_b: parseIdParam });
      for (const required of ["run_a", "run_b"] as const) {
        if (params[required] === undefined) {
          throw new ApiError(400, "missing_filter", `filter "${required}" is required`, {
            filter: required,
          });
        }
      }
      const a = requireRun(store, index, params.run_a as string);
      const b = requireRun(store, index, params.run_b as string);
      return { payload: compareRuns(a, b), fingerprint };
    }

    case "consensus": {
      if (second !== undefined) break;
      const params = parseQuery(url, PAGINATION_PARAMS);
      const ordered = runsInOrder(index);
      const perRun = ordered.map((run) => ({
        run: run.summary.id,
        timestamp: run.summary.timestamp,
        consensus: run.run.consensus,
      }));
      const invoked = ordered
        .flatMap(questionRows)
        .filter((row) => row.consensus_invoked === true);
      const { pagination, items } = paginate(invoked, pageOf(params));
      return {
        payload: { runs: embedList(perRun), invoked_questions: { pagination, items } },
        fingerprint,
      };
    }

    case "operations": {
      if (second !== undefined) break;
      parseQuery(url, {});
      const ordered = runsInOrder(index);
      const latencySeries = ordered.map((run) => ({
        run: run.summary.id,
        timestamp: run.summary.timestamp,
        latency: run.run.latency,
      }));
      const errors = ordered
        .filter((run) => run.run.errors.length > 0)
        .map((run) => ({ run: run.summary.id, errors: run.run.errors }));
      return {
        payload: {
          latency: {
            // Unweighted mean across runs — labeled as such; null when no runs.
            mean_of_runs: {
              avg_retrieval_ms: meanOf(latencySeries.map((l) => l.latency.avg_retrieval_ms)),
              avg_answer_ms: meanOf(latencySeries.map((l) => l.latency.avg_answer_ms)),
              p95_retrieval_ms: meanOf(latencySeries.map((l) => l.latency.p95_retrieval_ms)),
            },
            series: embedList(latencySeries),
          },
          errors: embedList(errors),
          invalid: embedList(index.invalid),
          baselines: embedList(
            index.baselines.map((b) => ({ id: b.id, timestamp: b.timestamp, overall: b.overall })),
          ),
          cohorts: embedList(index.cohorts),
          parity: embedList(index.parity),
          model_roster: store.getModelRoster(),
          index: { fingerprint, roots: index.roots, stats: index.stats },
        },
        fingerprint,
      };
    }
  }

  throw new ApiError(404, "unknown_route", `no such API route: /api/${parts.join("/")}`);
}

function compareRuns(a: LoadedRun, b: LoadedRun): object {
  const categories = [
    ...new Set([
      ...Object.keys(a.run.scores.by_category),
      ...Object.keys(b.run.scores.by_category),
    ]),
  ].sort();
  const byCategory = categories.map((category) => {
    const cellA = a.run.scores.by_category[category] ?? null;
    const cellB = b.run.scores.by_category[category] ?? null;
    return {
      category,
      a: cellA,
      b: cellB,
      delta_accuracy:
        cellA && cellB ? Math.round((cellB.accuracy - cellA.accuracy) * 10) / 10 : null,
    };
  });

  // Question identities are only meaningful within the same benchmark and
  // dataset — unrelated runs may reuse question ids, so cross-dataset
  // pairing would fabricate flips. Score deltas are still reported.
  const comparable =
    a.summary.benchmark === b.summary.benchmark && a.summary.dataset === b.summary.dataset;
  let questions: object;
  if (!comparable) {
    questions = {
      comparable: false,
      reason: "runs use different benchmark/dataset; question identities are not comparable",
      paired: 0,
      flips: [],
    };
  } else {
    const questionsB = new Map(b.run.questions.map((q) => [q.question_id, q]));
    const idsA = new Set(a.run.questions.map((q) => q.question_id));
    const flips: Array<{ question_id: string; a_correct: boolean; b_correct: boolean }> = [];
    let paired = 0;
    for (const qa of a.run.questions) {
      const qb = questionsB.get(qa.question_id);
      if (!qb) continue;
      paired += 1;
      if (qa.correct !== qb.correct) {
        flips.push({ question_id: qa.question_id, a_correct: qa.correct, b_correct: qb.correct });
      }
    }
    questions = {
      comparable: true,
      paired,
      flips,
      only_in_a: a.run.questions.filter((q) => !questionsB.has(q.question_id)).length,
      only_in_b: b.run.questions.filter((q) => !idsA.has(q.question_id)).length,
    };
  }
  return {
    run_a: a.summary,
    run_b: b.summary,
    overall_delta:
      Math.round((b.run.scores.overall_accuracy - a.run.scores.overall_accuracy) * 10) / 10,
    by_category: byCategory,
    questions,
  };
}
