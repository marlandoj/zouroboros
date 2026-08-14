#!/usr/bin/env bun
/**
 * zo-memory-retrieval MCP Server v1.0
 *
 * Exposes production memory retrieval capabilities as MCP tools.
 * Wraps zo-memory-system CLI commands to provide benchmark adapter parity.
 *
 * Tools:
 *   memory_fact_search        — Hybrid FTS + vector search (with HyDE + graph boost)
 *   memory_procedure_retrieve — Lookup procedure by name with version history
 *   memory_episode_retrieve   — Query episodic memory by entity, outcome, date range
 *   memory_cross_persona_search — Access-gated cross-pool search
 *   memory_swarm_dag_retrieve — Retrieve swarm task/DAG results
 *   memory_hybrid_deep        — Full pipeline with HyDE + reciprocal rank fusion
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { $ } from "bun";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { retrieveFederated, type RetrievalMode } from "./federated-retrieval.js";
import { createProductionFederatedBackend } from "./production-federated-backend.js";

// --- Config ---
const PORT = parseInt(process.env.PORT || "48402");
const BEARER_TOKEN = process.env.ZO_MEMORY_MCP_TOKEN || "";
const MEMORY_CLI = process.env.MEMORY_CLI || "/home/workspace/Skills/zo-memory-system/scripts/memory.ts";
const CROSS_PERSONA = process.env.CROSS_PERSONA_CLI || "/home/workspace/Skills/zouroboros/skills/memory/scripts/cross-persona.ts";
const SWARM_SCRIPTS = process.env.SWARM_SCRIPTS || "/home/workspace/Skills/zouroboros/skills/swarm/scripts";
const SHARED_DB = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

// --- Helpers ---
function checkAuth(req: Request): boolean {
  if (!BEARER_TOKEN) return false; // fail closed: no token configured = deny
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (token.length !== BEARER_TOKEN.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ BEARER_TOKEN.charCodeAt(i);
  }
  return mismatch === 0;
}

function shEscape(s: string): string {
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

async function runCli(cmd: string[], env?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn({
    cmd,
    env: { ...process.env, ZO_MEMORY_DB: SHARED_DB, ...env },
    cwd: "/home/workspace",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`CLI failed (exit ${proc.exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

async function memoryCli(args: string[]): Promise<string> {
  return runCli(["bun", MEMORY_CLI, ...args]);
}

async function crossPersonaCli(args: string[]): Promise<string> {
  return runCli(["bun", CROSS_PERSONA, ...args]);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ==========================================================================
// TOOL IMPLEMENTATIONS
// ==========================================================================

// ─── 1. memory_fact_search — hybrid FTS+vector search ───
async function toolFactSearch(args: {
  query: string;
  persona?: string;
  limit?: number;
  hyde?: boolean;
  graph_boost?: boolean;
}): Promise<string> {
  const limit = args.limit || 5;
  const flags: string[] = [];
  if (args.persona) flags.push(`--persona=${args.persona}`);
  if (args.hyde === false) flags.push("--no-hyde");
  if (args.graph_boost === false) flags.push("--no-graph");
  flags.push(`--limit=${limit}`);

  const result = await memoryCli(["hybrid", args.query, ...flags]);
  return result;
}

// ─── 2. memory_procedure_retrieve — procedure lookup ───
async function toolProcedureRetrieve(args: {
  name: string;
  show_versions?: boolean;
}): Promise<string> {
  if (args.show_versions) {
    const result = await memoryCli(["procedures", "--show", args.name]);
    return result;
  }
  // List matching procedures
  const result = await memoryCli(["procedures"]);
  const lines = result.split("\n").filter((l) => l.toLowerCase().includes(args.name.toLowerCase()));
  return lines.length > 0 ? lines.join("\n") : `No procedure matching "${args.name}" found.`;
}

// ─── 3. memory_episode_retrieve — episodic memory query ───
async function toolEpisodeRetrieve(args: {
  entity?: string;
  outcome?: string;
  since?: string;
  limit?: number;
}): Promise<string> {
  const flags: string[] = [];
  if (args.entity) flags.push(`--entity=${args.entity}`);
  if (args.outcome) flags.push(`--outcome=${args.outcome}`);
  if (args.since) flags.push(`--since=${args.since}`);
  flags.push(`--limit=${args.limit || 10}`);

  const result = await memoryCli(["episodes", ...flags]);
  return result;
}

// ─── 4. memory_cross_persona_search — access-gated pool search ───
async function toolCrossPersonaSearch(args: {
  persona: string;
  query: string;
  limit?: number;
}): Promise<string> {
  const result = await crossPersonaCli([
    "search",
    "--persona", args.persona,
    "--query", args.query,
  ]);
  return result;
}

// ─── 5. memory_swarm_dag_retrieve — swarm results lookup ───
async function toolSwarmDagRetrieve(args: {
  dag_id?: string;
  recent?: number;
}): Promise<string> {
  const dagId = args.dag_id;
  if (dagId) {
    const resultsPath = `/tmp/swarm-results/${dagId}.json`;
    if (existsSync(resultsPath)) {
      const data = JSON.parse(readFileSync(resultsPath, "utf-8"));
      return `Swarm "${dagId}":\n${JSON.stringify(data, null, 2).slice(0, 2000)}`;
    }
    return `Swarm results for "${dagId}" not found.`;
  }
  // List recent swarm result files
  const limit = args.recent || 5;
  const swarmDir = "/tmp/swarm-results";
  if (!existsSync(swarmDir)) return "No recent swarm runs found.";
  try {
    const files = Array.from(
      new Bun.Glob("*.json").scanSync({ cwd: swarmDir, onlyFiles: true })
    )
      .map((f) => `${swarmDir}/${f}`)
      .slice(0, limit);
    if (files.length === 0) return "No recent swarm runs found.";
    const summaries: string[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(f, "utf-8"));
        summaries.push(`• ${data.swarmId || f}: ${data.status || "completed"} (${data.results?.length || 0} tasks)`);
      } catch {
        summaries.push(`• ${f} (unreadable)`);
      }
    }
    return `Recent swarm runs:\n${summaries.join("\n")}`;
  } catch {
    return "No recent swarm runs found.";
  }
}

// ─── 6. memory_hybrid_deep — full HyDE + RRF pipeline ───
async function toolHybridDeep(args: {
  question: string;
  persona?: string;
  top_k?: number;
}): Promise<string> {
  const k = args.top_k || 10;
  const persona = args.persona || "alaric";
  const result = await memoryCli(["hybrid", args.question, `--limit=${k}`, `--persona=${persona}`]);
  return result;
}

// ─── 7. memory_federated_retrieve — typed memory + code evidence ───
async function toolFederatedRetrieve(args: {
  query: string;
  mode?: RetrievalMode | "auto";
  limit?: number;
  expand?: boolean;
  code_project?: string;
}) {
  const backend = createProductionFederatedBackend({
    dbPath: SHARED_DB,
    memoryCli,
    codeProject: args.code_project,
  });
  return retrieveFederated({
    query: args.query,
    mode: args.mode,
    limit: args.limit,
    expand: args.expand,
  }, backend);
}

// ==========================================================================
// MCP SERVER + HTTP TRANSPORT
// ==========================================================================

const TOOLS = [
  {
    name: "memory_fact_search",
    description: "Hybrid search across facts using FTS + vector embeddings. Returns ranked facts matching the query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query text" },
        persona: { type: "string", description: "Filter by persona (optional)" },
        limit: { type: "number", description: "Max results (default: 5)" },
        hyde: { type: "boolean", description: "Enable HyDE expansion (default: true)" },
        graph_boost: { type: "boolean", description: "Enable graph neighbor boost (default: true)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_procedure_retrieve",
    description: "Retrieve a stored procedure/workflow by name. Returns steps, versions, and success stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Procedure name to look up" },
        show_versions: { type: "boolean", description: "Show full version history (default: true)" },
      },
      required: ["name"],
    },
  },
  {
    name: "memory_episode_retrieve",
    description: "Query episodic memory — past events, outcomes, and associated entities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity: { type: "string", description: "Filter by entity name (optional)" },
        outcome: { type: "string", description: "Filter by outcome: success, failure, resolved, ongoing" },
        since: { type: "string", description: "Filter events since date (e.g. '7 days ago')" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: [],
    },
  },
  {
    name: "memory_cross_persona_search",
    description: "Search memory across pools with access-gating. Respects persona pools and inheritance chains.",
    inputSchema: {
      type: "object" as const,
      properties: {
        persona: { type: "string", description: "Persona performing the search (determines access)" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["persona", "query"],
    },
  },
  {
    name: "memory_swarm_dag_retrieve",
    description: "Retrieve swarm DAG execution results or list recent swarm runs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dag_id: { type: "string", description: "Specific swarm/dag ID to retrieve" },
        recent: { type: "number", description: "List N most recent swarm runs (default: 5)" },
      },
      required: [],
    },
  },
  {
    name: "memory_hybrid_deep",
    description: "Full-pipeline hybrid search with HyDE expansion and reciprocal rank fusion. Best for complex questions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Complex search question" },
        persona: { type: "string", description: "Persona context for access (default: alaric)" },
        top_k: { type: "number", description: "Number of top results (default: 10)" },
      },
      required: ["question"],
    },
  },
  {
    name: "memory_federated_retrieve",
    description: "Deterministically route across memory and code evidence, with temporal provenance and at most one graph hop. Returns zouroboros.evidence.v1 JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Memory or code evidence question" },
        mode: { type: "string", enum: ["auto", "vector-only", "graph-only", "federated"], description: "Routing mode (default: auto)" },
        limit: { type: "number", description: "Maximum evidence items (1-50, default: 10)" },
        expand: { type: "boolean", description: "Allow bounded one-hop expansion (default: true)" },
        code_project: { type: "string", description: "Indexed codebase-memory project (default: home-workspace-packages)" },
      },
      required: ["query"],
    },
  },
];

const mcpServer = new Server(
  { name: "zo-memory-retrieval", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result = "";
    switch (name) {
      case "memory_fact_search":
        result = await toolFactSearch(args as any);
        break;
      case "memory_procedure_retrieve":
        result = await toolProcedureRetrieve(args as any);
        break;
      case "memory_episode_retrieve":
        result = await toolEpisodeRetrieve(args as any);
        break;
      case "memory_cross_persona_search":
        result = await toolCrossPersonaSearch(args as any);
        break;
      case "memory_swarm_dag_retrieve":
        result = await toolSwarmDagRetrieve(args as any);
        break;
      case "memory_hybrid_deep":
        result = await toolHybridDeep(args as any);
        break;
      case "memory_federated_retrieve":
        result = JSON.stringify(await toolFederatedRetrieve(args as any));
        break;
      default:
        result = `Unknown tool: ${name}`;
    }
    return { content: [{ type: "text", text: result }] };
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error: ${error.message || error}` }], isError: true };
  }
});

// --- Session management ---
const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport }>();

function createSessionServer(requestedSessionId?: string) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => requestedSessionId || randomUUID(),
    onsessioninitialized: (sessionId) => {
      console.error(`[zo-memory-mcp] Session: ${sessionId}`);
    },
    onsessionclosed: (sessionId) => {
      console.error(`[zo-memory-mcp] Closed: ${sessionId}`);
      sessions.delete(sessionId);
    },
  });
  mcpServer.connect(transport);
  return { transport };
}

// --- Bun HTTP server ---
const httpServer = Bun.serve({
  port: PORT,
  hostname: process.env.ZO_MEMORY_MCP_HOST || "127.0.0.1",
  idleTimeout: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        version: "1.0.0",
        tools: TOOLS.map((t) => t.name),
        sessions: sessions.size,
        db: SHARED_DB,
        db_exists: existsSync(SHARED_DB),
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/mcp") {
      if (!checkAuth(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const sessionId = req.headers.get("mcp-session-id") || url.searchParams.get("sessionId");

      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!.transport.handleRequest(req);
      }

      const { transport } = createSessionServer(sessionId || undefined);
      const response = await transport.handleRequest(req);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport });
      }

      return response;
    }

    // ─── Direct REST tool endpoints ───
    const toolMatch = url.pathname.match(/^\/tools\/([a-z0-9_-]+)$/i);
    if (toolMatch) {
      if (!checkAuth(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      const toolName = toolMatch[1];
      let body: any = {};
      try { if (req.method === "POST") body = await req.json(); } catch {}
      const args: any = body.arguments !== undefined ? body.arguments : body;

      try {
        let result: unknown = "";
        switch (toolName) {
          case "memory_fact_search": result = await toolFactSearch(args); break;
          case "memory_procedure_retrieve": result = await toolProcedureRetrieve(args); break;
          case "memory_episode_retrieve": result = await toolEpisodeRetrieve(args); break;
          case "memory_cross_persona_search": result = await toolCrossPersonaSearch(args); break;
          case "memory_swarm_dag_retrieve": result = await toolSwarmDagRetrieve(args); break;
          case "memory_hybrid_deep": result = await toolHybridDeep(args); break;
          case "memory_federated_retrieve": result = await toolFederatedRetrieve(args); break;
          default:
            return new Response(JSON.stringify({ error: `Unknown tool: ${toolName}` }), { status: 404, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ tool: toolName, result }), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/tools") {
      if (!checkAuth(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      const names = TOOLS.map(t => ({ name: t.name, description: t.description }));
      return new Response(JSON.stringify({ tools: names, count: names.length }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.error(`[zo-memory-mcp] HTTP server on http://0.0.0.0:${PORT}/mcp`);
console.error(`[zo-memory-mcp] Health: http://0.0.0.0:${PORT}/health`);
console.error(`[zo-memory-mcp] Auth: ${BEARER_TOKEN ? "required" : "none"}`);
console.error(`[zo-memory-mcp] DB: ${SHARED_DB} (exists=${existsSync(SHARED_DB)})`);
