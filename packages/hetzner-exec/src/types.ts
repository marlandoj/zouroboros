// Shared types for the hetzner-exec MCP server.
//
// The request/response contract is the heart of ZOU-415: every other task in
// the Hetzner Compute Annex becomes a one-liner that POSTs to this server.

/** Request body for POST /run (and the args of the `hetzner_exec_run` MCP tool). */
export interface ExecRequest {
  /** Shell command to execute (passed as a single argv element to `sh -c`). */
  command: string;
  /** If set, run inside a fresh `docker run --rm <image>` container. */
  docker_image?: string;
  /** Environment variables for the command (keys must match ^[A-Za-z_][A-Za-z0-9_]*$). */
  env?: Record<string, string>;
  /** Hard timeout in milliseconds. The process is SIGKILLed on expiry (exit_code 124). */
  timeout?: number;
  /** If true, run in a fresh isolated sandbox (docker `--network=none` or a fresh hcloud VM). */
  sandbox?: boolean;
}

/** Response body returned by POST /run. */
export interface ExecResponse {
  /** Process exit code. -1 (with `error` set) for sandbox-provision or unrecoverable spawn failures; 124 for timeout. */
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration of the command in milliseconds. */
  elapsed_ms: number;
  /** Identifier of the sandbox used, when `sandbox: true`. */
  sandbox_id?: string;
  /** Set when the server could not run the command (sandbox provision failure, spawn error, timeout). */
  error?: string;
}

export type SandboxProviderKind = "docker" | "hcloud";

/** A captured command run (internal — used by the executor and sandbox providers). */
export interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
}
