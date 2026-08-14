// Request validation. Catches malformed bodies before they reach the executor,
// turning type errors into clean 400s instead of 500s. Also hardens against env
// injection (env keys must be valid shell var names).

import type { ExecRequest } from "./types";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ValidationError extends Error {}

/** Parse + validate an unknown payload into a well-typed ExecRequest. Throws on any violation. */
export function validateRequest(input: unknown): ExecRequest {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const r = input as Record<string, unknown>;

  if (typeof r.command !== "string" || r.command.length === 0) {
    throw new ValidationError("command must be a non-empty string");
  }
  const out: ExecRequest = { command: r.command };

  if (r.docker_image !== undefined) {
    if (typeof r.docker_image !== "string" || r.docker_image.length === 0) {
      throw new ValidationError("docker_image must be a non-empty string");
    }
    out.docker_image = r.docker_image;
  }

  if (r.env !== undefined) {
    if (typeof r.env !== "object" || r.env === null) {
      throw new ValidationError("env must be an object of {string: string}");
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (!ENV_KEY_RE.test(k)) {
        throw new ValidationError(`invalid env key: '${k}' (must match ^[A-Za-z_][A-Za-z0-9_]*$)`);
      }
      if (typeof v !== "string") {
        throw new ValidationError(`env value for '${k}' must be a string`);
      }
      env[k] = v;
    }
    out.env = env;
  }

  if (r.timeout !== undefined) {
    if (typeof r.timeout !== "number" || !Number.isInteger(r.timeout) || r.timeout < 0) {
      throw new ValidationError("timeout must be a non-negative integer (milliseconds)");
    }
    out.timeout = r.timeout;
  }

  if (r.sandbox !== undefined) {
    if (typeof r.sandbox !== "boolean") {
      throw new ValidationError("sandbox must be a boolean");
    }
    out.sandbox = r.sandbox;
  }

  // Reject unknown keys (fail closed; surfaces typos like `commands` instead of `command`).
  const allowed = new Set(["command", "docker_image", "env", "timeout", "sandbox"]);
  for (const k of Object.keys(r)) {
    if (!allowed.has(k)) {
      throw new ValidationError(`unknown field: '${k}'`);
    }
  }

  return out;
}
