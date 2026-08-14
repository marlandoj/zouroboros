import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const REPLAY_SCHEMA = 'zouroboros-replay/v1' as const;
export const REDACTION_VERSION = 'v1' as const;
export const MAX_BODY_BYTES = 1_048_576;

const SENSITIVE_KEY = /(^|[-_])(authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|signature)([-_]|$)/i;
const VOLATILE_HEADERS = new Set([
  'accept-encoding',
  'content-length',
  'date',
  'traceparent',
  'tracestate',
  'user-agent',
  'x-amzn-trace-id',
  'x-request-id',
]);

export interface ReplayHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  body_truncated?: boolean;
}

export interface ReplayHttpResponse {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body: string | null;
  body_truncated?: boolean;
}

export interface ReplayInteraction {
  sequence: number;
  kind: 'http' | 'tool';
  request: ReplayHttpRequest;
  response?: ReplayHttpResponse;
  error?: string;
  duration_ms: number;
  recorded_at: string;
  metadata?: Record<string, unknown>;
}

export interface ReplayCassette {
  schema: typeof REPLAY_SCHEMA;
  trace_id: string;
  source: string;
  created_at: string;
  redaction_version: typeof REDACTION_VERSION;
  interactions: ReplayInteraction[];
  metadata?: Record<string, unknown>;
  integrity_sha256?: string;
}

export interface CassetteIdentity {
  traceId: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMismatchError';
  }
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <REDACTED>')
    .replace(/\b(sk|pk|rk|ghp|github_pat|lin_api|xox[baprs])-[_A-Za-z0-9-]{8,}\b/g, '$1_<REDACTED>')
    .replace(/([?&](?:token|secret|password|api_?key|signature)=)[^&#\s]*/gi, '$1<REDACTED>');
}

export function redactValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '<REDACTED>';
  if (depth > 20) return '<MAX_DEPTH>';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, '', depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(child, childKey, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeHeaders(input: Headers | Record<string, string>): Record<string, string> {
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input);
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    out[key] = SENSITIVE_KEY.test(key) ? '<REDACTED>' : redactText(String(rawValue));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const pairs = [...url.searchParams.entries()]
      .map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? '<REDACTED>' : redactText(value)] as const)
      .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
    url.search = '';
    for (const [key, value] of pairs) url.searchParams.append(key, value);
    url.hash = '';
    return url.toString();
  } catch {
    return redactText(raw);
  }
}

export function sanitizeBody(raw: string | null): { body: string | null; truncated: boolean } {
  if (raw === null) return { body: null, truncated: false };
  let sanitized: string;
  try {
    sanitized = JSON.stringify(redactValue(JSON.parse(raw)));
  } catch {
    sanitized = redactText(raw);
  }
  const bytes = Buffer.byteLength(sanitized);
  if (bytes <= MAX_BODY_BYTES) return { body: sanitized, truncated: false };
  return {
    body: Buffer.from(sanitized).subarray(0, MAX_BODY_BYTES).toString('utf8'),
    truncated: true,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function canonicalRequest(request: ReplayHttpRequest): string {
  const stableHeaders = Object.fromEntries(
    Object.entries(request.headers)
      .filter(([key]) => !VOLATILE_HEADERS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(
    sortValue({
      method: request.method.toUpperCase(),
      url: sanitizeUrl(request.url),
      headers: stableHeaders,
      body: request.body,
      body_truncated: request.body_truncated === true,
    }),
  );
}

export function createCassette(identity: CassetteIdentity): ReplayCassette {
  return {
    schema: REPLAY_SCHEMA,
    trace_id: identity.traceId,
    source: identity.source,
    created_at: new Date().toISOString(),
    redaction_version: REDACTION_VERSION,
    interactions: [],
    ...(identity.metadata ? { metadata: redactValue(identity.metadata) as Record<string, unknown> } : {}),
  };
}

function digestPayload(cassette: ReplayCassette): string {
  const { integrity_sha256: _ignored, ...payload } = cassette;
  return JSON.stringify(sortValue(payload));
}

export function digestCassette(cassette: ReplayCassette): string {
  return createHash('sha256').update(digestPayload(cassette)).digest('hex');
}

export function saveCassette(path: string, cassette: ReplayCassette): void {
  const sanitizeRequest = (request: ReplayHttpRequest): ReplayHttpRequest => {
    const body = sanitizeBody(request.body);
    return {
      ...request,
      url: sanitizeUrl(request.url),
      headers: sanitizeHeaders(request.headers),
      body: body.body,
      ...(body.truncated ? { body_truncated: true } : {}),
    };
  };
  const sanitizeResponse = (response: ReplayHttpResponse): ReplayHttpResponse => {
    const body = sanitizeBody(response.body);
    return {
      ...response,
      headers: sanitizeHeaders(response.headers),
      body: body.body,
      ...(body.truncated ? { body_truncated: true } : {}),
    };
  };
  const safe: ReplayCassette = {
    ...cassette,
    metadata: cassette.metadata
      ? (redactValue(cassette.metadata) as Record<string, unknown>)
      : undefined,
    interactions: cassette.interactions.map((interaction, index) => ({
      ...interaction,
      sequence: index,
      request: sanitizeRequest(interaction.request),
      response: interaction.response ? sanitizeResponse(interaction.response) : undefined,
      error: interaction.error ? redactText(interaction.error) : undefined,
      metadata: interaction.metadata
        ? (redactValue(interaction.metadata) as Record<string, unknown>)
        : undefined,
    })),
  };
  safe.integrity_sha256 = digestCassette(safe);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadCassette(path: string): ReplayCassette {
  if (!existsSync(path)) throw new Error(`replay cassette not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReplayCassette;
  if (parsed.schema !== REPLAY_SCHEMA) throw new Error(`unsupported replay schema: ${String(parsed.schema)}`);
  if (!parsed.trace_id || !Array.isArray(parsed.interactions)) throw new Error(`invalid replay cassette: ${path}`);
  if (parsed.integrity_sha256 && parsed.integrity_sha256 !== digestCassette(parsed)) {
    throw new Error(`replay cassette integrity mismatch: ${path}`);
  }
  return parsed;
}

export class ReplayCursor {
  private index = 0;

  constructor(readonly cassette: ReplayCassette) {}

  next(request: ReplayHttpRequest, kind: ReplayInteraction['kind'] = 'http'): ReplayInteraction {
    const expected = this.cassette.interactions[this.index];
    if (!expected) {
      throw new ReplayMismatchError(
        `unexpected ${kind} interaction ${this.index}: ${request.method} ${request.url}`,
      );
    }
    if (expected.kind !== kind || canonicalRequest(expected.request) !== canonicalRequest(request)) {
      throw new ReplayMismatchError(
        `interaction ${this.index} mismatch: expected ${expected.kind} ${expected.request.method} ${expected.request.url}; observed ${kind} ${request.method} ${request.url}`,
      );
    }
    this.index += 1;
    return expected;
  }

  assertConsumed(): void {
    const remaining = this.cassette.interactions.length - this.index;
    if (remaining !== 0) {
      throw new ReplayMismatchError(`${remaining} recorded interaction(s) were not consumed`);
    }
  }

  get consumed(): number {
    return this.index;
  }
}
