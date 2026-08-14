import { FileCassetteRecorder, createReplayFetch, type ReplayMode } from './recorder.js';

const mode = (process.env.ZOUROBOROS_REPLAY_MODE ?? 'off') as ReplayMode;
const path = process.env.ZOUROBOROS_REPLAY_CASSETTE;

if ((mode === 'record' || mode === 'replay') && path) {
  const recorder = new FileCassetteRecorder({
    mode,
    path,
    traceId: process.env.ZO_TRACE_ID ?? process.env.ZOUROBOROS_TRACE_ID ?? crypto.randomUUID(),
    source: process.env.ZOUROBOROS_REPLAY_SOURCE ?? 'bun-fetch',
  });
  globalThis.fetch = createReplayFetch(recorder, globalThis.fetch);
  if (mode === 'replay') {
    process.on('beforeExit', () => {
      try {
        recorder.assertConsumed();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 70;
      }
    });
  }
}
