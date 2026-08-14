// Environment-driven configuration for the hetzner-exec server.
//
// All knobs are env vars so the same image can run on the Hetzner box, in a
// container with the docker socket mounted, or locally for the smoke test.

import type { SandboxProviderKind } from "./types";

export interface ServerConfig {
  /** TCP port to listen on (default 6666 — matches ZOU-414 UFW rule). */
  port: number;
  /** Shared bearer secret. Required to start (fail-closed). */
  authToken: string;
  /** Which sandbox provider to use when `sandbox: true`. */
  sandboxProvider: SandboxProviderKind;
  /** Default image for `docker run` when none is supplied. */
  defaultDockerImage: string;
  /** Default per-command timeout (ms). */
  defaultTimeoutMs: number;
  /** Hard ceiling on `timeout` (ms). Requests above this are rejected. */
  maxTimeoutMs: number;
  // ── hcloud sandbox provider ──────────────────────────────────────────────
  hcloudToken?: string;
  hcloudSshPrivateKey?: string;
  hcloudSshPublicKey?: string;
  hcloudServerType: string;
  hcloudImage: string;
  hcloudLocation: string;
  hcloudSshKeyName: string;
  /** Public base URL the box is reachable at, so sandbox VMs can POST results back. */
  publicBaseUrl?: string;
}

export const DEFAULT_PORT = 6666;
export const DEFAULT_DOCKER_IMAGE = "debian:12-slim";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 3_600_000; // 1 hour

export class ConfigError extends Error {}

/** Load config from an env map (defaults to `process.env`). Throws on bad values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const authToken = (env.HETZNER_EXEC_TOKEN ?? "").trim();
  const port = parsePort(env.HETZNER_EXEC_PORT, DEFAULT_PORT);

  const providerRaw = (env.HETZNER_EXEC_SANDBOX_PROVIDER ?? "docker").trim();
  if (providerRaw !== "docker" && providerRaw !== "hcloud") {
    throw new ConfigError(
      `HETZNER_EXEC_SANDBOX_PROVIDER must be 'docker' or 'hcloud' (got '${providerRaw}')`,
    );
  }
  const provider: SandboxProviderKind = providerRaw;

  return {
    port,
    authToken,
    sandboxProvider: provider,
    defaultDockerImage: (env.HETZNER_EXEC_DEFAULT_IMAGE ?? DEFAULT_DOCKER_IMAGE).trim(),
    defaultTimeoutMs: parseDurationMs(env.HETZNER_EXEC_DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: parseDurationMs(env.HETZNER_EXEC_MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
    hcloudToken: env.HETZNER_API_TOKEN,
    hcloudSshPrivateKey: env.HETZNER_SANDBOX_SSH_PRIVATE_KEY,
    hcloudSshPublicKey: env.HETZNER_SANDBOX_SSH_PUBLIC_KEY,
    hcloudServerType: (env.HETZNER_SANDBOX_SERVER_TYPE ?? "cx22").trim(),
    hcloudImage: (env.HETZNER_SANDBOX_IMAGE ?? "debian-12").trim(),
    hcloudLocation: (env.HETZNER_SANDBOX_LOCATION ?? "fsn1").trim(),
    hcloudSshKeyName: (env.HETZNER_SANDBOX_SSH_KEY_NAME ?? "hetzner-annex-key").trim(),
    publicBaseUrl: env.HETZNER_EXEC_PUBLIC_URL?.trim() || undefined,
  };
}

function parsePort(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`Invalid port: ${v}`);
  return n;
}

function parseDurationMs(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`Invalid duration: ${v}`);
  return n;
}
