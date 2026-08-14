#!/usr/bin/env bun
/**
 * hetzner-exec stdio ↔ HTTP bridge.
 *
 * Lets Zo register the remote hetzner-exec server as a **stdio** MCP server
 * (the transport `.mcp.json` already uses) even though the server itself
 * speaks HTTP JSON-RPC. Reads newline-delimited JSON-RPC requests from stdin,
 * forwards each to the server's `/mcp` endpoint with the bearer token, and
 * writes each JSON-RPC response (also newline-delimited) to stdout.
 *
 * Env:
 *   HETZNER_EXEC_URL    Base URL of the live hetzner-exec server (required)
 *   HETZNER_EXEC_TOKEN  Bearer token matching the server's HETZNER_EXEC_TOKEN (required)
 *
 * Register in `.mcp.json`:
 *   { "mcpServers": { "hetzner-exec": {
 *       "command": "bun",
 *       "args": ["<path>/mcp-stdio-bridge.ts"],
 *       "env": { "HETZNER_EXEC_URL": "https://box.example.com",
 *                "HETZNER_EXEC_TOKEN": "<secret>" } } } }
 */

import * as readline from "node:readline";

const baseUrl = process.env.HETZNER_EXEC_URL ?? "";
const token = process.env.HETZNER_EXEC_TOKEN ?? "";

if (!baseUrl || !token) {
  console.error("[hetzner-exec-bridge] HETZNER_EXEC_URL and HETZNER_EXEC_TOKEN are required");
  process.exit(1);
}

const endpoint = baseUrl.replace(/\/$/, "") + "/mcp";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let id: string | number | null = null;
  try {
    const parsed = JSON.parse(trimmed) as { id?: string | number | null };
    id = parsed.id ?? null;
  } catch {
    // malformed line — respond with a JSON-RPC parse error (id unknown)
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: trimmed,
    });
    const text = await res.text();
    if (text) {
      process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    }
    // empty body → notification, no response (JSON-RPC §4)
  } catch (e) {
    const err = {
      jsonrpc: "2.0" as const,
      id,
      error: { code: -32603, message: `bridge error: ${(e as Error).message}` },
    };
    process.stdout.write(JSON.stringify(err) + "\n");
  }
});

// Keep the process alive until stdin closes.
rl.on("close", () => {
  // stdin ended (client disconnected); nothing to flush.
});
