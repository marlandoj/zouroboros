import {
  ReplayCursor,
  createCassette,
  loadCassette,
  sanitizeBody,
  sanitizeHeaders,
  sanitizeUrl,
  saveCassette,
  type CassetteIdentity,
  type ReplayCassette,
  type ReplayHttpRequest,
  type ReplayHttpResponse,
  type ReplayInteraction,
} from './cassette.js';
import { existsSync } from 'node:fs';

export type ReplayMode = 'off' | 'record' | 'replay';

export interface RecorderOptions extends CassetteIdentity {
  path: string;
  mode: ReplayMode;
}

export interface ToolInteractionInput {
  name: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

function bodyFromUnknown(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return sanitizeBody(value).body;
  return sanitizeBody(JSON.stringify(value)).body;
}

export class FileCassetteRecorder {
  readonly cassette: ReplayCassette;
  readonly cursor: ReplayCursor | null;

  constructor(readonly options: RecorderOptions) {
    this.cassette = options.mode === 'replay' || (options.mode === 'record' && existsSync(options.path))
      ? loadCassette(options.path)
      : createCassette(options);
    if (options.mode === 'record' && this.cassette.trace_id !== options.traceId) {
      throw new Error(`replay cassette trace mismatch: expected ${options.traceId}, found ${this.cassette.trace_id}`);
    }
    this.cursor = options.mode === 'replay' ? new ReplayCursor(this.cassette) : null;
  }

  record(interaction: Omit<ReplayInteraction, 'sequence' | 'recorded_at'>): void {
    if (this.options.mode !== 'record') return;
    this.cassette.interactions.push({
      ...interaction,
      sequence: this.cassette.interactions.length,
      recorded_at: new Date().toISOString(),
    });
    saveCassette(this.options.path, this.cassette);
  }

  recordTool(input: ToolInteractionInput): void {
    const requestBody = bodyFromUnknown(input.arguments);
    const responseBody = bodyFromUnknown(input.result);
    this.record({
      kind: 'tool',
      request: {
        method: 'CALL',
        url: `tool://${encodeURIComponent(input.name)}`,
        headers: {},
        body: requestBody,
      },
      response: input.error === undefined
        ? {
            status: 200,
            status_text: 'OK',
            headers: {},
            body: responseBody,
          }
        : undefined,
      error: input.error === undefined ? undefined : String(input.error),
      duration_ms: input.durationMs ?? 0,
      metadata: input.metadata,
    });
  }

  replayTool(name: string, args?: unknown): ReplayInteraction {
    if (!this.cursor) throw new Error('replayTool requires replay mode');
    return this.cursor.next(
      {
        method: 'CALL',
        url: `tool://${encodeURIComponent(name)}`,
        headers: {},
        body: bodyFromUnknown(args),
      },
      'tool',
    );
  }

  assertConsumed(): void {
    this.cursor?.assertConsumed();
  }
}

async function toReplayRequest(input: RequestInfo | URL, init?: RequestInit): Promise<{ native: Request; replay: ReplayHttpRequest }> {
  const native = new Request(input, init);
  const rawBody = native.method === 'GET' || native.method === 'HEAD'
    ? null
    : await native.clone().text().catch(() => null);
  const body = sanitizeBody(rawBody);
  return {
    native,
    replay: {
      method: native.method.toUpperCase(),
      url: sanitizeUrl(native.url),
      headers: sanitizeHeaders(native.headers),
      body: body.body,
      ...(body.truncated ? { body_truncated: true } : {}),
    },
  };
}

async function toReplayResponse(response: Response): Promise<ReplayHttpResponse> {
  const noBody = response.status === 204 || response.status === 205 || response.status === 304;
  const rawBody = noBody ? null : await response.clone().text().catch(() => null);
  const body = sanitizeBody(rawBody);
  return {
    status: response.status,
    status_text: response.statusText,
    headers: sanitizeHeaders(response.headers),
    body: body.body,
    ...(body.truncated ? { body_truncated: true } : {}),
  };
}

export function createReplayFetch(
  recorder: FileCassetteRecorder,
  realFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { native, replay } = await toReplayRequest(input, init);

    if (recorder.options.mode === 'replay') {
      const interaction = recorder.cursor!.next(replay, 'http');
      if (interaction.error !== undefined) throw new Error(interaction.error);
      if (!interaction.response) throw new Error('recorded HTTP interaction has no response');
      const response = interaction.response;
      const noBody = response.status === 204 || response.status === 205 || response.status === 304;
      return new Response(noBody ? null : response.body, {
        status: response.status,
        statusText: response.status_text,
        headers: response.headers,
      });
    }

    if (recorder.options.mode !== 'record') return realFetch(native);

    const started = Date.now();
    try {
      const response = await realFetch(native);
      recorder.record({
        kind: 'http',
        request: replay,
        response: await toReplayResponse(response),
        duration_ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      recorder.record({
        kind: 'http',
        request: replay,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  }) as typeof globalThis.fetch;
}
