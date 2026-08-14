#!/usr/bin/env bun
/**
 * End-to-end smoke test for the hetzner-exec MCP server.
 *
 * Boots the real HTTP server in-process on an ephemeral port (direct host
 * execution path — no docker, no hcloud) and exercises:
 *   - GET  /healthz                       (no auth → 200)
 *   - POST /run  without auth             → 401
 *   - POST /run  {command:"echo hello"}   → {exit_code:0, stdout:"hello\n"}
 *   - POST /run  bad token                → 401
 *   - POST /run  empty command            → 400 (validation)
 *   - POST /mcp  initialize / tools/list / tools/call(echo hello)
 *   - POST /mcp  unknown method          → JSON-RPC -32601
 *
 * Exit 0 = all green.
 */

import { createServer } from "../src/server";
import type { ServerConfig } from "../src/config";

const TOKEN = "smoke-secret-token";

const config: ServerConfig = {
  port: 0,
  authToken: TOKEN,
  sandboxProvider: "docker",
  defaultDockerImage: "debian:12-slim",
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 3_600_000,
  hcloudServerType: "cx22",
  hcloudImage: "debian-12",
  hcloudLocation: "fsn1",
  hcloudSshKeyName: "hetzner-annex-key",
};

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const app = createServer(config);
await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const addr = app.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;

console.log(`hetzner-exec smoke test (port ${port})`);

try {
  // 1. healthz — no auth
  let r = await fetch(`${base}/healthz`);
  checkT("GET /healthz → 200", r.status === 200, `status=${r.status}`);
  let body: any = await r.json();
  checkT("/healthz body.status = ok", body.status === "ok", JSON.stringify(body));

  // 2. /run without auth → 401
  r = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "echo hello" }),
  });
  checkT("POST /run no auth → 401", r.status === 401, `status=${r.status}`);

  // 3. /run echo hello with bearer — the acceptance-criterion smoke test
  r = await fetch(`${base}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "echo hello" }),
  });
  checkT("POST /run echo hello → 200", r.status === 200, `status=${r.status}`);
  body = (await r.json()) as { exit_code?: number; stdout?: string; stderr?: string; elapsed_ms?: number };
  checkT("echo hello exit_code 0", body.exit_code === 0, `exit_code=${body.exit_code} stderr=${body.stderr}`);
  checkT("echo hello stdout = 'hello'", typeof body.stdout === "string" && body.stdout.trim() === "hello", `stdout=${JSON.stringify(body.stdout)}`);
  checkT("echo hello elapsed_ms is a non-negative number", typeof body.elapsed_ms === "number" && body.elapsed_ms >= 0, `elapsed_ms=${body.elapsed_ms}`);

  // 4. /run bad token → 401
  r = await fetch(`${base}/run`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
    body: JSON.stringify({ command: "echo hi" }),
  });
  checkT("POST /run bad token → 401", r.status === 401, `status=${r.status}`);

  // 5. /run empty command → 400 (validation)
  r = await fetch(`${base}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "" }),
  });
  checkT("POST /run empty command → 400", r.status === 400, `status=${r.status}`);

  // 6. MCP initialize
  r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  checkT("MCP initialize → 200", r.status === 200, `status=${r.status}`);
  body = (await r.json()) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
  checkT("MCP initialize protocolVersion present", !!body.result?.protocolVersion, JSON.stringify(body));
  checkT("MCP initialize serverInfo.name = hetzner-exec", body.result?.serverInfo?.name === "hetzner-exec", JSON.stringify(body));

  // 7. MCP tools/list
  r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  body = (await r.json()) as { result?: { tools?: Array<{ name?: string; inputSchema?: { required?: string[] } }> } };
  const tool = body.result?.tools?.[0];
  checkT("MCP tools/list → hetzner_exec_run tool", tool?.name === "hetzner_exec_run", JSON.stringify(body));
  checkT("MCP tool requires command", Array.isArray(tool?.inputSchema?.required) && tool.inputSchema.required.includes("command"), JSON.stringify(tool));

  // 8. MCP tools/call echo hello
  r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hetzner_exec_run", arguments: { command: "echo hello" } } }),
  });
  body = (await r.json()) as { result?: { content?: Array<{ text?: string }> } };
  const text = body.result?.content?.[0]?.text;
  let parsed: { exit_code?: number; stdout?: string } | null = null;
  try {
    parsed = text ? (JSON.parse(text) as { exit_code?: number; stdout?: string }) : null;
  } catch {
    parsed = null;
  }
  checkT("MCP tools/call echo hello → exit_code 0", parsed?.exit_code === 0, JSON.stringify(body));
  checkT("MCP tools/call echo hello → stdout 'hello'", parsed?.stdout != null && parsed.stdout.trim() === "hello", JSON.stringify(parsed));

  // 9. MCP unknown method → -32601
  r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nope" }),
  });
  body = (await r.json()) as { error?: { code?: number } };
  checkT("MCP unknown method → error -32601", body.error?.code === -32601, JSON.stringify(body));
} finally {
  await app.close();
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
