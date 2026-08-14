// Bearer-token authentication. Constant-time comparison so the secret value
// is not leaked via timing. The token may be any shared secret OR a Zo access
// token — both are treated opaquely (Zo sends it; we compare it).

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time-ish comparison of a presented bearer token against the
 * expected secret. Returns false on any mismatch (including empty values)
 * without raising.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an `Authorization` header value, or null. */
export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const m = /^Bearer\s+(.+)$/i.exec(trimmed);
  return m ? m[1].trim() : null;
}

/** True if `header` carries a bearer token matching `expected`. */
export function isAuthorized(header: string | undefined | null, expected: string): boolean {
  const presented = extractBearer(header);
  if (presented === null) return false;
  return tokenMatches(presented, expected);
}
