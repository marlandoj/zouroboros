export function parseRetryAfter(value: string | null, nowMs: number, fallbackMs: number, maxMs: number): number {
  if (value === null) return fallbackMs;
  return Number(value) * 1000;
}
