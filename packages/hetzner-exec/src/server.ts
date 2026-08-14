// hetzner-exec HTTP server. Four routes:
//   POST /run                    — REST contract: {command, docker_image?, env?, timeout?, sandbox?}
//                                  → {exit_code, stdout, stderr, elapsed_ms, sandbox_id?, error?}
//   POST /mcp                    — MCP JSON-RPC (initialize / tools/list / tools/call) so the
//                                  server can be registered as an MCP server in Zo. Exposes one
//                                  tool, `hetzner_exec_run`, whose args are the /run contract.
//   POST /sandbox/callback/:id   — receives the result POST from an hcloud sandbox VM
//                                  (the only egress the VM is allowed to make) and resolves the
//                                  pending /run promise.
//   GET  /healthz                — unauthenticated liveness probe.

import { createServer as httpCreateServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExecResponse, RunResult } from "./types";
import { buildDirectArgv, buildDockerArgv, LocalRunner, type CommandRunner, type RunnerArgs } from "./executor";
import { createCallbackRegistry, createSandboxProvider, type CallbackRegistry, type SandboxProvider } from "./sandbox";
import type { ServerConfig } from "./config";
import { tokenMatches, extractBearer } from "./auth";
import { validateRequest, ValidationError } from "./validate";

export const PKG_VERSION = "0.1.0";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_TOOL_NAME = "hetzner_exec_run";

export interface ServerDeps {
  runner?: CommandRunner;
  sandbox?: SandboxProvider;
  callbacks?: CallbackRegistry;
}

export interface AppHandle {
  server: Server;
  callbacks: CallbackRegistry;
  config: ServerConfig;
  close(): Promise<void>;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(config: ServerConfig, req: IncomingMessage): boolean {
  if (!config.authToken) return false; // fail-closed: no token configured ⇒ reject all
  const presented = extractBearer(req.headers.authorization);
  return presented !== null && tokenMatches(presented, config.authToken);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function resolveTimeout(requested: number | undefined, config: ServerConfig): number {
  if (requested === undefined || requested === 0) return config.defaultTimeoutMs;
  return Math.min(requested, config.maxTimeoutMs);
}

function parseCallbackResult(parsed: unknown): RunResult | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.exit_code !== "number" ||
    typeof p.stdout !== "string" ||
    typeof p.stderr !== "string" ||
    typeof p.elapsed_ms !== "number"
  ) {
    return null;
  }
  return {
    exit_code: p.exit_code,
    stdout: p.stdout,
    stderr: p.stderr,
    elapsed_ms: p.elapsed_ms,
    timed_out: typeof p.timed_out === "boolean" ? p.timed_out : false,
  };
}

// ─── dispatch (shared by /run and /mcp tools/call) ─────────────────────────────

interface DispatchDeps {
  runner: CommandRunner;
  sandbox: SandboxProvider;
}

async function dispatchRun(parsed: unknown, config: ServerConfig, deps: DispatchDeps): Promise<ExecResponse> {
  const validated = validateRequest(parsed);
  const timeoutMs = resolveTimeout(validated.timeout, config);

  if (validated.sandbox) {
    const handle = await deps.sandbox.run(validated, timeoutMs);
    try {
      const r = await handle.result;
      return {
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        elapsed_ms: r.elapsed_ms,
        sandbox_id: handle.sandboxId,
        error: r.timed_out ? "timeout" : undefined,
      };
    } finally {
      await handle.destroy();
    }
  }

  let args: RunnerArgs;
  if (validated.docker_image) {
    args = { argv: buildDockerArgv(validated.docker_image, validated.command, validated.env), env: undefined, timeoutMs };
  } else {
    args = { argv: buildDirectArgv(validated.command), env: validated.env, timeoutMs };
  }
  const r = await deps.runner.run(args);
  return {
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
    elapsed_ms: r.elapsed_ms,
    error: r.timed_out ? "timeout" : undefined,
  };
}

// ─── MCP JSON-RPC ─────────────────────────────────────────────────────────────

const RUN_TOOL = {
  name: MCP_TOOL_NAME,
  description:
    "Run a shell command on the Hetzner Compute Annex. Pass docker_image to run in a fresh container; sandbox=true runs in a fresh isolated environment (a docker --network=none container, or a fresh Hetzner VM that POSTs its result back). Returns exit_code, stdout, stderr, elapsed_ms.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute (passed to `sh -c`)." },
      docker_image: { type: "string", description: "Docker image to run inside (e.g. 'debian:12-slim'). Omit to run on the host." },
      env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for the command." },
      timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. 0/omitted ⇒ server default." },
      sandbox: { type: "boolean", description: "Run in a fresh isolated environment." },
    },
    required: ["command"],
  },
};

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function mcpErr(id: string | number | null, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function mcpHandleOne(item: unknown, config: ServerConfig, deps: DispatchDeps): Promise<McpResponse | null> {
  if (typeof item !== "object" || item === null) return mcpErr(null, -32600, "Invalid Request");
  const r = item as { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return mcpErr(r.id ?? null, -32600, "Invalid Request");
  const id = r.id ?? null;

  switch (r.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "hetzner-exec", version: PKG_VERSION },
        },
      };
    case "notifications/initialized":
      return null; // notification — no response
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [RUN_TOOL] } };
    case "tools/call": {
      const params = (r.params ?? {}) as { name?: string; arguments?: unknown };
      if (params.name !== MCP_TOOL_NAME) return mcpErr(id, -32602, `unknown tool: ${String(params.name)}`);
      try {
        const result = await dispatchRun(params.arguments, config, deps);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
      } catch (e) {
        if (e instanceof ValidationError) {
          return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `validation error: ${e.message}` }] } };
        }
        return mcpErr(id, -32603, `execution failed: ${(e as Error).message}`);
      }
    }
    default:
      return mcpErr(id, -32601, `method not found: ${r.method}`);
  }
}

async function handleMcp(
  parsed: unknown,
  config: ServerConfig,
  deps: DispatchDeps,
  res: ServerResponse,
): Promise<void> {
  if (Array.isArray(parsed)) {
    const responses: McpResponse[] = [];
    for (const item of parsed) {
      const resp = await mcpHandleOne(item, config, deps);
      if (resp !== null) responses.push(resp);
    }
    return sendJson(res, 200, responses);
  }
  const resp = await mcpHandleOne(parsed, config, deps);
  if (resp === null) {
    // notification — accept without a body
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end();
    return;
  }
  return sendJson(res, 200, resp);
}

// ─── server factory ────────────────────────────────────────────────────────────

export function createServer(config: ServerConfig, deps: ServerDeps = {}): AppHandle {
  const callbacks = deps.callbacks ?? createCallbackRegistry();
  const runner = deps.runner ?? new LocalRunner();
  const sandbox = deps.sandbox ?? createSandboxProvider(config, runner, callbacks);

  const server: Server = httpCreateServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, { status: "ok", uptime: process.uptime() });
    }

    if (!authorized(config, req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    const dispatchDeps: DispatchDeps = { runner, sandbox };

    try {
      if (method === "POST" && path === "/run") {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" });
        }
        try {
          const result = await dispatchRun(parsed, config, dispatchDeps);
          return sendJson(res, 200, result);
        } catch (e) {
          if (e instanceof ValidationError) return sendJson(res, 400, { error: e.message });
          return sendJson(res, 500, { error: "execution failed", detail: (e as Error).message });
        }
      }

      if (method === "POST" && path === "/mcp") {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          return sendJson(res, 200, mcpErr(null, -32700, "Parse error"));
        }
        return handleMcp(parsed, config, dispatchDeps, res);
      }

      if (method === "POST" && path.startsWith("/sandbox/callback/")) {
        const runId = decodeURIComponent(path.slice("/sandbox/callback/".length));
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" });
        }
        const r = parseCallbackResult(parsed);
        if (!r) return sendJson(res, 400, { error: "invalid callback payload" });
        const delivered = callbacks.deliver(runId, r);
        return sendJson(res, delivered ? 200 : 404, { received: delivered });
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (e) {
      return sendJson(res, 500, { error: "internal error", detail: (e as Error).message });
    }
  });

  return {
    server,
    callbacks,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function startServer(config: ServerConfig): AppHandle {
  const app = createServer(config);
  app.server.listen(config.port, () => {
    console.log(`[hetzner-exec] listening on :${config.port} (sandbox provider=${config.sandboxProvider})`);
  });
  return app;
}
