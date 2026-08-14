export function parseRetryAfter(value: string | null, nowMs: number, fallbackMs: number, maxMs: number): number {
  if (!value?.trim()) return Math.min(fallbackMs, maxMs);
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - nowMs;
  if (!Number.isFinite(requested) || requested < 0) return Math.min(fallbackMs, maxMs);
  return Math.min(Math.round(requested), maxMs);
}
