export type ParseResult = { ok: true; value: number } | { ok: false; error: string };
export function parsePort(raw: string): ParseResult {
  if (!/^\d+$/.test(raw.trim())) return { ok: false, error: "port must be an integer" };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) return { ok: false, error: "port outside 1..65535" };
  return { ok: true, value };
}
