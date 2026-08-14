import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCassette, ReplayMismatchError } from '../replay/cassette.js';
import { createReplayFetch, FileCassetteRecorder } from '../replay/recorder.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCassette(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zouro-replay-test-'));
  dirs.push(dir);
  return join(dir, 'trace.json');
}

describe('local replay cassette', () => {
  test('record redacts secrets, persists mode 0600, and replays without network', async () => {
    const path = tempCassette();
    const recorder = new FileCassetteRecorder({
      mode: 'record',
      path,
      traceId: 'trace-redaction',
      source: 'test',
    });
    const recordFetch = createReplayFetch(
      recorder,
      (async () => new Response(JSON.stringify({ value: 'ok', token: 'response-secret' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=secret' },
      })) as typeof fetch,
    );

    const response = await recordFetch('https://service.test/value?api_key=query-secret', {
      method: 'POST',
      headers: { authorization: 'Bearer header-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'body-secret', input: 'safe' }),
    });
    expect((await response.json() as { value: string }).value).toBe('ok');

    const raw = readFileSync(path, 'utf8');
    for (const secret of ['query-secret', 'header-secret', 'body-secret', 'response-secret', 'session=secret']) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('<REDACTED>');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const replayRecorder = new FileCassetteRecorder({
      mode: 'replay',
      path,
      traceId: 'trace-redaction',
      source: 'test',
    });
    const replayFetch = createReplayFetch(
      replayRecorder,
      (async () => { throw new Error('network must not be called'); }) as typeof fetch,
    );
    const replayed = await replayFetch('https://service.test/value?api_key=different-secret', {
      method: 'POST',
      headers: { authorization: 'Bearer another-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'another-body-secret', input: 'safe' }),
    });
    expect((await replayed.json() as { value: string }).value).toBe('ok');
    replayRecorder.assertConsumed();
  });

  test('strict sequence rejects a different request', async () => {
    const path = tempCassette();
    const recorder = new FileCassetteRecorder({ mode: 'record', path, traceId: 'strict', source: 'test' });
    const recordFetch = createReplayFetch(
      recorder,
      (async () => new Response('ok')) as typeof fetch,
    );
    await recordFetch('https://service.test/expected');

    const replayRecorder = new FileCassetteRecorder({ mode: 'replay', path, traceId: 'strict', source: 'test' });
    const replayFetch = createReplayFetch(replayRecorder);
    await expect(replayFetch('https://service.test/other')).rejects.toBeInstanceOf(ReplayMismatchError);
  });

  test('integrity mismatch is rejected before execution', async () => {
    const path = tempCassette();
    const recorder = new FileCassetteRecorder({ mode: 'record', path, traceId: 'integrity', source: 'test' });
    const recordFetch = createReplayFetch(recorder, (async () => new Response('ok')) as typeof fetch);
    await recordFetch('https://service.test/value');
    writeFileSync(path, readFileSync(path, 'utf8').replace('service.test', 'tampered.test'));
    expect(() => loadCassette(path)).toThrow('integrity mismatch');
  });
});
