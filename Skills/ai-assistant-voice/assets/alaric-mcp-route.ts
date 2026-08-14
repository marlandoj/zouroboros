// /api/<slug>-mcp — JSON-RPC 2.0 MCP server exposing Zo tools to OpenAI Realtime.
//
// Required Zo Secrets:
//   {{MCP_TOKEN_ENV}} — shared secret (32-byte hex). OpenAI Realtime sends this
//                      in the server_url query (?t=...) since the zo.space
//                      Cloudflare proxy strips Authorization: Bearer. The env-var
//                      name is configurable via the deploy script's
//                      --mcp-token-secret flag (default: MCP_SHARED_TOKEN).
//   ZO_API_KEY        — used to call api.zo.computer/mcp upstream.
//
// Optional Zo Secrets:
//   MEMORY_DB_PATH    — absolute path to a SQLite memory backend exposing
//                       `open_loops` and `facts_fts` tables. If unset or the
//                       file is missing, the memory_search and list_open_loops
//                       tools are advertised but degrade gracefully with a
//                       "memory not configured" response. Default:
//                       /home/workspace/.zo/memory/shared-facts.db
//   LINEAR_API_KEY    — Linear personal API key used by the read-only
//                       linear_project_updates tool.
//
// JSON-RPC methods implemented:
//   initialize, notifications/initialized, tools/list, tools/call, ping
//
// Auth precedence (first match wins):
//   1. X-Mcp-Token header
//   2. Authorization: Bearer ...
//   3. ?t= query param (Realtime path)

import type { Context } from "hono";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const ZO_MCP_ENDPOINT = "https://api.zo.computer/mcp";
const DEFAULT_MEMORY_DB = "/home/workspace/.zo/memory/shared-facts.db";
const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH || DEFAULT_MEMORY_DB;
function memoryBackendAvailable(): boolean {
  try { return existsSync(MEMORY_DB_PATH); } catch { return false; }
}

const rlBuckets = new Map<string, number[]>();
const RL_WINDOW_MS = 60_000;
const RL_LIMIT = 240;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const arr = (rlBuckets.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_LIMIT) {
    rlBuckets.set(ip, arr);
    return false;
  }
  arr.push(now);
  rlBuckets.set(ip, arr);
  if (rlBuckets.size > 5000) {
    for (const [k, v] of rlBuckets) {
      const fresh = v.filter((t) => now - t < RL_WINDOW_MS);
      if (fresh.length === 0) rlBuckets.delete(k);
      else rlBuckets.set(k, fresh);
    }
  }
  return true;
}

function getClientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    (c.req.header("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

type JsonRpcId = string | number | null;

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function jsonRpcOk(id: JsonRpcId, result: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(extraHeaders || {}),
    },
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function toolResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text: text.slice(0, 8000) }],
    isError,
  };
}

async function callZoMcp(
  name: string,
  args: Record<string, unknown>,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<{ ok: true; text: string } | { ok: false; error: string; isTimeout?: boolean }> {
  async function attempt(candidate: string) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(ZO_MCP_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${candidate}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: Date.now(),
          params: { name, arguments: args },
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const raw = await resp.text();
      if (!resp.ok) return { ok: false as const, error: `Zo MCP HTTP ${resp.status}: ${raw.slice(0, 300)}` };
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false as const, error: `Zo MCP non-JSON: ${raw.slice(0, 300)}` };
      }
      if (parsed?.error) {
        return {
          ok: false as const,
          error: `Zo MCP error: ${JSON.stringify(parsed.error).slice(0, 300)}`,
          authFailed: parsed.error.code === -32001,
        };
      }
      const content = parsed?.result?.content;
      const text =
        Array.isArray(content) && content[0]?.text
          ? String(content[0].text)
          : JSON.stringify(parsed?.result ?? parsed);
      if (parsed?.result?.isError) return { ok: false as const, error: text.slice(0, 600) };
      return { ok: true as const, text };
    } catch (err: any) {
      clearTimeout(timer);
      return {
        ok: false as const,
        error: err?.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : err?.message || "Unknown error",
        isTimeout: err?.name === "AbortError",
      };
    }
  }

  const primary = await attempt(apiKey);
  const fallback = process.env.ZO_ASK_TOKEN;
  if (!primary.ok && "authFailed" in primary && primary.authFailed && fallback && fallback !== apiKey) {
    return attempt(fallback);
  }
  return primary;
}

// =========================================================================
// TOOL DEFINITIONS — ordered by pack
// =========================================================================
const TOOL_DEFINITIONS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  // -------- ESSENTIALS --------
  {
    name: "list_open_loops",
    description: "List the user's currently open work items (loops/tasks-in-progress) from his workspace memory. Use when they ask about open loops, current work, what's in progress, what's pending, or backlog.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max items (1-50). Default 10." },
        status: { type: "string", enum: ["open", "resolved", "stale", "all"], description: "Filter by status. Default 'open'." },
      },
    },
  },
  {
    name: "memory_search",
    description: "Search the user's persistent memory (facts, decisions, preferences, conventions, project state) via FTS over a pluggable SQLite backend (default: shared-facts.db; override with MEMORY_DB_PATH). Use when they ask 'what do you remember about X', 'recall Z', or any question about prior decisions, project history, or stored facts. Degrades gracefully when no memory backend is configured.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (sanitized to alnum + space + dash + underscore)." },
        limit: { type: "integer", description: "Max hits (1-20). Default 5." },
        scope: { type: "string", description: "Persona scope filter (e.g. 'shared', '<persona-slug>'). Default 'any' returns all scopes." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_agents",
    description: "List the user's persistent Zo agents (long-running named assistants).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_automations",
    description: "List the user's scheduled automations (cron-style scheduled tasks).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_calendar_events",
    description: "List upcoming events on the user's primary Google Calendar.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: { type: "integer", description: "Max events (1-20). Default 5." },
      },
    },
  },
  {
    name: "send_email",
    description: "Send the user a markdown email. Use when they say 'email me', 'send me an email', 'follow up by email'.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Markdown email body." },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "send_sms",
    description: "Send the user an SMS text message. Use when they say 'text me', 'send me a text', 'sms me'.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text message body (keep short)." },
        contact_name: { type: "string", description: "Optional named contact." },
      },
      required: ["message"],
    },
  },
  {
    name: "read_file",
    description: "Read the first 200 lines of a workspace file. Path must start with /home/workspace/.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path under /home/workspace/." },
      },
      required: ["path"],
    },
  },
  {
    name: "workspace_search",
    description: "Grep the user's workspace for content or filenames.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term." },
        kind: { type: "string", enum: ["content", "filename"], description: "Default 'content'." },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description: "Search the live web for current information (news, weather, prices, recent events).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query." },
        time_range: { type: "string", enum: ["anytime", "day", "week", "month", "year"], description: "Default 'week'." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description: "List files and folders in a workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path under /home/workspace/." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_personas",
    description: "List the user's available Zo personas. Pass query to return a focused match instead of the truncated full fleet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional persona name or keyword to focus the result." },
      },
    },
  },
  {
    name: "list_user_services",
    description: "List the user's hosted user services (HTTP/TCP/process services).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_space_errors",
    description: "Check for runtime errors in the user's zo.space routes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "web_research",
    description: "Deeper web research with category filters (better quality than web_search). Use for in-depth queries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Research query." },
        category: { type: "string", description: "Optional: company, research_paper, pdf, github, tweet, personal_site, linkedin_profile, financial_report, people." },
      },
      required: ["query"],
    },
  },
  {
    name: "find_similar_links",
    description: "Find webpages similar to a given URL (semantic similarity).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Source URL." },
      },
      required: ["url"],
    },
  },
  {
    name: "maps_search",
    description: "Search Google Maps for places (restaurants, stores, services).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Place query, e.g. 'coffee near Phoenix'." },
        open_now: { type: "boolean", description: "Filter to currently open." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_webpage",
    description: "Fetch and read a webpage's text content (or YouTube transcript).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Webpage URL." },
      },
      required: ["url"],
    },
  },
  {
    name: "gmail_search",
    description: "Search the user's Gmail with a query (e.g. 'from:boss subject:invoice newer_than:7d').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query." },
        max_results: { type: "integer", description: "Max results (1-20). Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read",
    description: "Read a specific Gmail message by ID.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Gmail message ID." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "linear_project_updates",
    description: "Read Linear project status, progress, teams, and recent issue updates. Optional query filters project names.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional project-name filter." },
        max_projects: { type: "integer", description: "Max projects (1-20). Default 10." },
        max_issues: { type: "integer", description: "Recent issues per project (1-10). Default 5." },
      },
    },
  },
  {
    name: "factory_status",
    description: "Digest of the Zouroboros Software Factory: active and recent build executions with ticket, state, branch, PR, and blocker/error. Use when the user asks 'what is the factory doing', 'build status', 'any builds running/failed', or about factory throughput.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max executions to summarize (1-20). Default 8." },
        state: { type: "string", description: "Optional state filter, e.g. 'failed', 'merged', 'running'. Default all states." },
      },
    },
  },
  {
    name: "factory_run_details",
    description: "Full detail for one factory build: lifecycle state, stage, branch, PR, timestamps, error, executor failover trail, risk tier, evidence. Use after factory_status when the user drills into one ticket or asks why a build failed. Accepts a ZOU identifier (e.g. 'ZOU-1011') or execution id (e.g. 'exec-f7e41626').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ZOU-nnn ticket identifier or exec-xxxxxxxx execution id." },
      },
      required: ["id"],
    },
  },
  {
    name: "github_status",
    description: "GitHub repository status: open pull requests and recent workflow runs (CI). Use when the user asks about PRs, checks, CI, or repo activity. Default repo is marlandoj/zouroboros.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name repo slug. Default 'marlandoj/zouroboros'." },
      },
    },
  },
  {
    name: "linear_issue_details",
    description: "Read one Linear issue in depth: title, state, assignee, priority, description, latest comments, and related/blocking issues. Use when the user asks about a specific ticket like 'ZOU-1110'.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Issue identifier, e.g. 'ZOU-1110'." },
      },
      required: ["identifier"],
    },
  },
  {
    name: "drive_search",
    description: "Search the user's Google Drive for files and documents by name or Drive query. Use when they ask to find a doc, sheet, or file in Drive.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "File name term (e.g. 'Q3 budget') or raw Drive query (e.g. \"name contains 'report'\")." },
        max_results: { type: "integer", description: "Max files (1-20). Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "service_logs",
    description: "Tail the log of a hosted user service (stdout or stderr). Use when the user asks what a service is logging or why it is failing. Get service names from list_user_services.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name as it appears in /dev/shm logs, e.g. 'zouroboros-support'." },
        lines: { type: "integer", description: "Lines to tail (10-200). Default 60." },
        stream: { type: "string", enum: ["out", "err"], description: "stdout or stderr. Default 'out'." },
      },
      required: ["service"],
    },
  },
  {
    name: "alaric_query",
    description: "Delegate a complex READ-ONLY question to the full Alaric assistant (files, code, research, cross-system analysis) and return a concise spoken summary. Slow (up to ~40s) — tell the user you are working on it. Use only when no more specific tool fits.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to research. Self-contained; include any names/paths mentioned." },
      },
      required: ["question"],
    },
  },
  // -------- POWER --------
  {
    name: "image_search",
    description: "Search the web for images of real-world objects, places, or concepts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Image query." },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_image",
    description: "Generate an illustration or image from a natural language prompt. Saves to workspace.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description prompt." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "save_webpage",
    description: "Save a webpage to the user's Articles folder for later reference.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Webpage URL." },
      },
      required: ["url"],
    },
  },
  {
    name: "transcribe_audio",
    description: "Transcribe an audio file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to audio file under /home/workspace/." },
      },
      required: ["path"],
    },
  },
  {
    name: "transcribe_video",
    description: "Transcribe a video file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to video file under /home/workspace/." },
      },
      required: ["path"],
    },
  },
  {
    name: "service_doctor",
    description: "Diagnose health of a hosted user service.",
    inputSchema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "User service ID." },
      },
      required: ["service_id"],
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event via Google Calendar quick-add (natural language, e.g. 'lunch with Kevin tomorrow at noon').",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Quick-add natural language event description." },
      },
      required: ["text"],
    },
  },
  // -------- POWER_WITH_WRITES --------
  {
    name: "set_active_persona",
    description: "Switch the user's active Zo persona by ID. Affects subsequent chat sessions.",
    inputSchema: {
      type: "object",
      properties: {
        persona_id: { type: "string", description: "Persona UUID." },
      },
      required: ["persona_id"],
    },
  },
  {
    name: "create_agent",
    description: "Create a new scheduled Zo agent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instructions: { type: "string" },
        rrule: { type: "string", description: "RFC5545 rrule for schedule." },
      },
      required: ["name", "instructions", "rrule"],
    },
  },
  {
    name: "edit_agent",
    description: "Edit an existing Zo agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        instructions: { type: "string" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "create_automation",
    description: "Create a new scheduled automation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        rrule: { type: "string" },
      },
      required: ["name", "prompt", "rrule"],
    },
  },
  {
    name: "edit_automation",
    description: "Edit an existing scheduled automation.",
    inputSchema: {
      type: "object",
      properties: {
        automation_id: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["automation_id"],
    },
  },
  {
    name: "write_space_route",
    description: "Create or fully replace a zo.space route.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        route_type: { type: "string", enum: ["api", "page"] },
        code: { type: "string" },
      },
      required: ["path", "route_type", "code"],
    },
  },
  {
    name: "edit_space_route",
    description: "Edit an existing zo.space route by sending only changed sections.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        code_edit: { type: "string" },
      },
      required: ["path", "code_edit"],
    },
  },
  {
    name: "publish_site",
    description: "Publish a Zo Site by site directory.",
    inputSchema: {
      type: "object",
      properties: {
        site_path: { type: "string", description: "Absolute path to site directory under /home/workspace/." },
      },
      required: ["site_path"],
    },
  },
];

// =========================================================================
// CUSTOM TOOL HANDLERS
// =========================================================================

async function handleListOpenLoops(args: any, apiKey: string) {
  if (!memoryBackendAvailable()) {
    return toolResult(`Memory backend not configured (no file at ${MEMORY_DB_PATH}). Set MEMORY_DB_PATH in Zo Secrets to point at a SQLite DB exposing an 'open_loops' table.`, true);
  }
  const limit = Math.min(Math.max(parseInt(args?.limit ?? "10", 10) || 10, 1), 50);
  const ALLOWED = new Set(["open", "resolved", "stale", "superseded", "all"]);
  const requested = String(args?.status ?? "open");
  if (!ALLOWED.has(requested)) return toolResult("invalid status; allowed: open|resolved|stale|superseded|all", true);
  const where = requested === "all" ? "" : `WHERE status='${requested}'`;
  const sql = `SELECT id || '|' || title || '|' || kind || '|' || priority FROM open_loops ${where} ORDER BY priority DESC, updated_at DESC LIMIT ${limit};`;
  const cmd = `sqlite3 ${MEMORY_DB_PATH} "${sql.replace(/"/g, '\\"')}"`;
  const r = await callZoMcp("bash", { cmd }, apiKey, 10_000);
  if (!r.ok) return toolResult(r.error, true);
  const m = r.text.match(/stdout='([\s\S]*?)', stderr=/);
  const stdout = m ? m[1].replace(/\\n/g, "\n") : r.text;
  const lines = stdout.split("\n").filter(Boolean);
  if (!lines.length) return toolResult(`No ${requested} loops.`);
  const summary = lines
    .slice(0, limit)
    .map((line) => {
      const [, title, kind, priority] = line.split("|");
      return `• [${kind}] ${title?.slice(0, 120)} (p=${priority})`;
    })
    .join("\n");
  return toolResult(`Open loops (${lines.length} ${requested}):\n${summary}`);
}

async function handleMemorySearch(args: any, apiKey: string) {
  if (!memoryBackendAvailable()) {
    return toolResult(`Memory backend not configured (no file at ${MEMORY_DB_PATH}). Set MEMORY_DB_PATH in Zo Secrets to point at a SQLite DB exposing 'facts' + 'facts_fts' tables.`, true);
  }
  const rawQuery = String(args?.query || "").trim();
  if (!rawQuery) return toolResult("missing query", true);
  const query = rawQuery.replace(/[^a-zA-Z0-9 _\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!query) return toolResult("query empty after sanitization", true);
  const limit = Math.min(Math.max(parseInt(args?.limit ?? "5", 10) || 5, 1), 20);
  const requestedScope = String(args?.scope ?? "any").trim();
  const safeScope = /^[a-zA-Z0-9_\-]{1,40}$/.test(requestedScope) ? requestedScope : "any";
  const personaFilter = safeScope === "any" ? "" : `AND f.persona = '${safeScope}'`;
  const sql = `SELECT f.entity || '.' || COALESCE(f.key,'') || '|' || substr(f.value,1,200) || '|' || f.decay_class || '|' || COALESCE(f.persona,'shared') FROM facts_fts ft JOIN facts f ON f.rowid=ft.rowid WHERE facts_fts MATCH '${query}' ${personaFilter} ORDER BY rank LIMIT ${limit};`;
  const cmd = `sqlite3 ${MEMORY_DB_PATH} "${sql.replace(/"/g, '\\"')}"`;
  const r = await callZoMcp("bash", { cmd }, apiKey, 10_000);
  if (!r.ok) return toolResult(r.error, true);
  const m = r.text.match(/stdout='([\s\S]*?)', stderr=/);
  const stdout = m ? m[1].replace(/\\n/g, "\n") : r.text;
  const lines = stdout.split("\n").filter(Boolean);
  if (!lines.length) return toolResult(`No memory hits for "${query}".`);
  const summary = lines
    .slice(0, limit)
    .map((line) => {
      const [path, value, decay, persona] = line.split("|");
      return `• [${decay}/${persona}] ${path}: ${value?.slice(0, 180)}`;
    })
    .join("\n");
  return toolResult(`Memory hits for "${query}" (${lines.length}):\n${summary}`);
}

// =========================================================================
// PASS-THROUGH HANDLERS (sanitized wrappers around Zo MCP tools)
// =========================================================================

async function handleReadFile(args: any, apiKey: string) {
  const target = String(args?.path || "").trim();
  if (!target.startsWith("/home/workspace/") || target.includes("..") || target.includes("\0")) {
    return toolResult("Only /home/workspace/ files allowed (no traversal).", true);
  }
  const r = await callZoMcp(
    "read_file",
    { target_file: target, start_line: 1, end_line: 200 },
    apiKey,
    15_000,
  );
  return r.ok ? toolResult(r.text) : toolResult(r.error, true);
}

async function handleWorkspaceSearch(args: any, apiKey: string) {
  const query = String(args?.query || "").trim();
  if (!query) return toolResult("missing query", true);
  const searchKind = args?.kind === "filename" ? "filename" : "content";
  const r = await callZoMcp("grep_search", { query, search_kind: searchKind, location: "USER" }, apiKey, 15_000);
  return r.ok ? toolResult(r.text) : toolResult(r.error, true);
}

async function handleListFiles(args: any, apiKey: string) {
  const target = String(args?.path || "").trim();
  if (!target.startsWith("/home/workspace/") || target.includes("..") || target.includes("\0")) {
    return toolResult("Only /home/workspace/ paths allowed.", true);
  }
  const r = await callZoMcp("list_directory", { path: target }, apiKey, 10_000);
  return r.ok ? toolResult(r.text) : toolResult(r.error, true);
}

async function passthrough(name: string, args: Record<string, unknown>, apiKey: string, timeoutMs = 15_000) {
  const r = await callZoMcp(name, args, apiKey, timeoutMs);
  return r.ok ? toolResult(r.text) : toolResult(r.error, true);
}

async function handleListAgents(_a: any, k: string) { return passthrough("list_agents", {}, k); }
async function handleListAutomations(_a: any, k: string) { return passthrough("list_automations", {}, k); }
async function handleListPersonas(a: any, k: string) {
  const r = await callZoMcp("list_personas", {}, k, 9_000);
  if (!r.ok) return toolResult(r.error, true);
  const query = String(a?.query || "").trim().slice(0, 120);
  if (!query) return toolResult(r.text);
  const index = r.text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return toolResult(`No persona matched "${query}".`);
  const start = Math.max(0, index - 800);
  const end = Math.min(r.text.length, index + query.length + 1600);
  return toolResult(`Persona match for "${query}":\n${r.text.slice(start, end)}`);
}
async function handleListUserServices(_a: any, k: string) { return passthrough("list_user_services", {}, k); }
async function handleGetSpaceErrors(_a: any, k: string) { return passthrough("get_space_errors", {}, k); }
async function handleServiceDoctor(a: any, k: string) {
  const id = String(a?.service_id || "").trim();
  if (!id) return toolResult("missing service_id", true);
  return passthrough("service_doctor", { service: id }, k, 30_000);
}
async function handleSetActivePersona(a: any, k: string) {
  const id = String(a?.persona_id || "").trim();
  if (id.length !== 36) return toolResult("invalid persona_id", true);
  return passthrough("set_active_persona", { persona_id: id }, k);
}

async function handleListCalendarEvents(args: any, apiKey: string) {
  const maxResults = Math.min(parseInt(args?.max_results ?? "5", 10) || 5, 20);
  return passthrough(
    "use_app_google_calendar",
    { tool_name: "google_calendar-list-events", configured_props: { calendarId: "primary", maxResults } },
    apiKey,
    15_000,
  );
}

async function handleCalendarCreateEvent(args: any, apiKey: string) {
  const text = String(args?.text || "").trim();
  if (!text) return toolResult("missing event text", true);
  return passthrough(
    "use_app_google_calendar",
    { tool_name: "google_calendar-quick-add-event", configured_props: { calendarId: "primary", text } },
    apiKey,
    15_000,
  );
}

async function handleSendEmail(args: any, apiKey: string) {
  const subject = String(args?.subject || "").trim();
  const body = String(args?.body || "").trim();
  if (!subject) return toolResult("missing subject", true);
  if (!body) return toolResult("missing body", true);
  const r = await callZoMcp("send_email_to_user", { subject, markdown_body: body }, apiKey, 20_000);
  return r.ok ? toolResult("Email sent.") : toolResult(r.error, true);
}

async function handleSendSms(args: any, apiKey: string) {
  const message = String(args?.message || "").trim();
  if (!message) return toolResult("missing message", true);
  const r = await callZoMcp(
    "send_sms_to_user",
    { message, ...(args?.contact_name ? { contact_name: String(args.contact_name) } : {}) },
    apiKey,
    20_000,
  );
  return r.ok ? toolResult("SMS sent.") : toolResult(r.error, true);
}

async function handleWebSearch(args: any, apiKey: string) {
  const query = String(args?.query || "").trim();
  if (!query) return toolResult("missing query", true);
  const time_range = ["anytime", "day", "week", "month", "year"].includes(args?.time_range)
    ? args.time_range
    : "week";
  return passthrough("web_search", { query, time_range }, apiKey, 25_000);
}

async function handleWebResearch(args: any, apiKey: string) {
  const query = String(args?.query || "").trim();
  if (!query) return toolResult("missing query", true);
  const params: Record<string, unknown> = { query };
  if (args?.category) params.category = String(args.category);
  return passthrough("web_research", params, apiKey, 30_000);
}

async function handleFindSimilarLinks(args: any, apiKey: string) {
  const url = String(args?.url || "").trim();
  if (!url.startsWith("http")) return toolResult("invalid url", true);
  return passthrough("find_similar_links", { url }, apiKey, 20_000);
}

async function handleMapsSearch(args: any, apiKey: string) {
  const query = String(args?.query || "").trim();
  if (!query) return toolResult("missing query", true);
  const params: Record<string, unknown> = { query };
  if (typeof args?.open_now === "boolean") params.open_now = args.open_now;
  return passthrough("maps_search", params, apiKey, 20_000);
}

async function handleReadWebpage(args: any, apiKey: string) {
  const url = String(args?.url || "").trim();
  if (!url.startsWith("http")) return toolResult("invalid url", true);
  return passthrough("read_webpage", { url }, apiKey, 30_000);
}

async function handleSaveWebpage(args: any, apiKey: string) {
  const url = String(args?.url || "").trim();
  if (!url.startsWith("http")) return toolResult("invalid url", true);
  return passthrough("save_webpage", { url }, apiKey, 30_000);
}

async function handleImageSearch(args: any, apiKey: string) {
  const query = String(args?.query || "").trim();
  if (!query) return toolResult("missing query", true);
  return passthrough("image_search", { query }, apiKey, 20_000);
}

async function handleGenerateImage(args: any, apiKey: string) {
  const prompt = String(args?.prompt || "").trim();
  if (!prompt) return toolResult("missing prompt", true);
  return passthrough("generate_image", { prompt, file_stem: `alaric-voice-${Date.now()}` }, apiKey, 60_000);
}

async function handleTranscribeAudio(args: any, apiKey: string) {
  const target = String(args?.path || "").trim();
  if (!target.startsWith("/home/workspace/") || target.includes("..") || target.includes("\0")) {
    return toolResult("Only /home/workspace/ paths allowed.", true);
  }
  return passthrough("transcribe_audio", { audio_file_path: target }, apiKey, 120_000);
}

async function handleTranscribeVideo(args: any, apiKey: string) {
  const target = String(args?.path || "").trim();
  if (!target.startsWith("/home/workspace/") || target.includes("..") || target.includes("\0")) {
    return toolResult("Only /home/workspace/ paths allowed.", true);
  }
  return passthrough("transcribe_video", { video_file_path: target }, apiKey, 180_000);
}

async function handleGmailSearch(args: any, apiKey: string) {
  const query = String(args?.query || "").trim();
  if (!query) return toolResult("missing query", true);
  const max_results = Math.min(parseInt(args?.max_results ?? "10", 10) || 10, 20);
  return passthrough(
    "use_app_gmail",
    { tool_name: "gmail-find-email", configured_props: { q: query, maxResults: max_results, fields: ["subject", "sender", "date"] } },
    apiKey,
    20_000,
  );
}

async function handleGmailRead(args: any, apiKey: string) {
  const id = String(args?.message_id || "").trim();
  if (!id) return toolResult("missing message_id", true);
  return passthrough(
    "use_app_gmail",
    { tool_name: "gmail-get-message", configured_props: { messageId: id } },
    apiKey,
    20_000,
  );
}

async function handleLinearProjectUpdates(args: any) {
  const linearApiKey = process.env.LINEAR_API_KEY;
  if (!linearApiKey) {
    return toolResult("Linear is not configured. Add LINEAR_API_KEY in Zo Settings > Advanced > Secrets.", true);
  }

  const query = String(args?.query || "").trim().slice(0, 120).toLowerCase();
  const maxProjects = Math.min(Math.max(parseInt(args?.max_projects ?? "10", 10) || 10, 1), 20);
  const maxIssues = Math.min(Math.max(parseInt(args?.max_issues ?? "5", 10) || 5, 1), 10);
  const graphql = `
    query VoiceLinearProjectUpdates($projectLimit: Int!, $issueLimit: Int!) {
      projects(first: $projectLimit) {
        nodes {
          name
          url
          updatedAt
          progress
          status { name }
          teams { nodes { name } }
          issues(first: $issueLimit) {
            nodes {
              identifier
              title
              updatedAt
              state { name }
              assignee { name }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: linearApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: graphql,
      variables: { projectLimit: 50, issueLimit: maxIssues },
    }),
  });

  const raw = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return toolResult(`Linear returned a non-JSON response (HTTP ${response.status}).`, true);
  }
  if (!response.ok || payload?.errors?.length) {
    const detail = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    return toolResult(`Linear request failed: ${String(detail).slice(0, 300)}`, true);
  }

  const allProjects = Array.isArray(payload?.data?.projects?.nodes)
    ? payload.data.projects.nodes
    : [];
  const projects = allProjects
    .filter((project: any) => !query || String(project?.name || "").toLowerCase().includes(query))
    .slice(0, maxProjects);
  if (!projects.length) {
    return toolResult(query ? `No Linear projects matched "${query}".` : "No Linear projects found.");
  }

  const formatDate = (value: unknown) => {
    const date = new Date(String(value || ""));
    return Number.isNaN(date.getTime()) ? "unknown date" : date.toISOString().slice(0, 10);
  };
  const lines = projects.map((project: any) => {
    const status = project?.status?.name || "no status";
    const progress = typeof project?.progress === "number"
      ? `, ${Math.round(project.progress * 100)}% complete`
      : "";
    const teams = Array.isArray(project?.teams?.nodes)
      ? project.teams.nodes.map((team: any) => team?.name).filter(Boolean).join(", ")
      : "";
    const issues = Array.isArray(project?.issues?.nodes) ? project.issues.nodes : [];
    const issueLines = issues.slice(0, maxIssues).map((issue: any) => {
      const assignee = issue?.assignee?.name ? `; ${issue.assignee.name}` : "";
      return `  - ${issue?.identifier || "issue"}: ${issue?.title || "untitled"} [${issue?.state?.name || "no state"}; updated ${formatDate(issue?.updatedAt)}${assignee}]`;
    });
    return [
      `• ${project?.name || "Unnamed project"} — ${status}${progress}; updated ${formatDate(project?.updatedAt)}${teams ? `; team ${teams}` : ""}`,
      project?.url ? `  ${project.url}` : "",
      ...issueLines,
    ].filter(Boolean).join("\n");
  });
  return toolResult(`Linear project updates${query ? ` matching "${query}"` : ""}:\n${lines.join("\n")}`);
}

// =========================================================================
// OPERATOR READ TOOLS (factory / github / linear issue / drive / logs / fallback)
// =========================================================================

// Factory execution state is fragmented across rotated conveyor roots plus the
// canonical checkout; any single directory under-counts. Union by execution_id,
// keeping the record with the newest state_updated_at.
const FACTORY_CANONICAL_STATE = "/home/workspace/Projects/zouroboros-software-factory/state";
const FACTORY_RUNTIME_ROOT = "/home/workspace/.runtime";

function factoryStateRoots(): string[] {
  const roots = [FACTORY_CANONICAL_STATE];
  try {
    for (const entry of readdirSync(FACTORY_RUNTIME_ROOT)) {
      if (!entry.startsWith("factory-conveyor")) continue;
      const candidate = `${FACTORY_RUNTIME_ROOT}/${entry}/Projects/zouroboros-software-factory/state`;
      if (existsSync(candidate)) roots.push(candidate);
    }
  } catch { /* runtime root absent — canonical only */ }
  return roots;
}

type FactoryExec = Record<string, any>;

function loadFactoryExecutions(): FactoryExec[] {
  const byId = new Map<string, FactoryExec>();
  for (const root of factoryStateRoots()) {
    let files: string[] = [];
    try { files = readdirSync(root); } catch { continue; }
    for (const file of files) {
      if (!/^exec-exec-[a-z0-9]+\.json$/.test(file)) continue;
      try {
        const rec = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
        const id = String(rec?.execution_id || file.replace(/^exec-|\.json$/g, ""));
        const prev = byId.get(id);
        const recTime = Date.parse(rec?.state_updated_at || rec?.completed_at || rec?.started_at || "") || 0;
        const prevTime = prev ? (Date.parse(prev?.state_updated_at || prev?.completed_at || prev?.started_at || "") || 0) : -1;
        if (!prev || recTime >= prevTime) byId.set(id, rec);
      } catch { /* skip unparseable record */ }
    }
  }
  return [...byId.values()].sort((a, b) =>
    (Date.parse(b?.state_updated_at || b?.started_at || "") || 0) - (Date.parse(a?.state_updated_at || a?.started_at || "") || 0)
  );
}

function factoryExecTime(rec: FactoryExec): string {
  const ts = rec?.state_updated_at || rec?.completed_at || rec?.started_at;
  const date = new Date(String(ts || ""));
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

async function handleFactoryStatus(args: any) {
  const limit = Math.min(Math.max(parseInt(args?.limit ?? "8", 10) || 8, 1), 20);
  const stateFilter = String(args?.state || "").trim().toLowerCase().slice(0, 30);
  let execs = loadFactoryExecutions();
  if (!execs.length) return toolResult("No factory execution records found.");
  const counts = new Map<string, number>();
  for (const rec of execs) {
    const state = String(rec?.state || "unknown");
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  if (stateFilter) execs = execs.filter((rec) => String(rec?.state || "").toLowerCase() === stateFilter);
  const countLine = [...counts.entries()].map(([state, n]) => `${n} ${state}`).join(", ");
  const lines = execs.slice(0, limit).map((rec) => {
    const pr = rec?.pr_number ? `PR #${rec.pr_number}` : "no PR";
    const error = rec?.error ? `; error: ${String(rec.error).slice(0, 110)}` : "";
    return `• ${rec?.identifier || "?"} [${rec?.state || "?"}/${rec?.stage || "?"}] ${String(rec?.ticket_title || "").slice(0, 70)} — ${pr}; ${factoryExecTime(rec)}${error} (${rec?.execution_id})`;
  });
  const filterNote = stateFilter ? ` matching state '${stateFilter}' (${execs.length})` : "";
  return toolResult(`Factory: ${countLine}.${filterNote}\n${lines.join("\n") || "No executions match."}`);
}

async function handleFactoryRunDetails(args: any) {
  const rawId = String(args?.id || "").trim();
  if (!rawId) return toolResult("missing id", true);
  const needle = rawId.toLowerCase();
  const execs = loadFactoryExecutions();
  const matches = execs.filter((rec) =>
    String(rec?.identifier || "").toLowerCase() === needle ||
    String(rec?.execution_id || "").toLowerCase() === needle ||
    String(rec?.execution_id || "").toLowerCase() === `exec-${needle}`
  );
  if (!matches.length) return toolResult(`No factory execution found for '${rawId}'. Try factory_status to list recent runs.`, true);
  const sections = matches.slice(0, 3).map((rec) => {
    const started = rec?.started_at ? String(rec.started_at) : "unknown";
    const completed = rec?.completed_at ? String(rec.completed_at) : "in progress";
    const parts = [
      `${rec?.identifier || "?"} ${rec?.execution_id || ""} — ${String(rec?.ticket_title || "").slice(0, 100)}`,
      `state: ${rec?.state || "?"} / stage: ${rec?.stage || "?"}; delivery target: ${rec?.delivery_target || "?"}; target reached: ${rec?.target_reached}`,
      `branch: ${rec?.branch_name || "none"}; ${rec?.pr_number ? `PR #${rec.pr_number}` : "no PR"}; repo: ${rec?.repo_path || "?"}`,
      `started: ${started}; completed: ${completed}; last update: ${factoryExecTime(rec)}`,
    ];
    if (rec?.risk?.tier) parts.push(`risk: ${rec.risk.tier} (score ${rec.risk.score ?? "?"}, mode ${rec.risk.mode ?? "?"})`);
    if (rec?.error) parts.push(`error: ${String(rec.error).slice(0, 300)}`);
    if (rec?.failover_trail) parts.push(`failover: ${String(rec.failover_trail).slice(0, 250)}`);
    if (rec?.result_summary) parts.push(`result: ${String(rec.result_summary).slice(0, 250)}`);
    if (rec?.evidence_manifest?.path) parts.push(`evidence: ${rec.evidence_manifest.path}`);
    return parts.join("\n");
  });
  return toolResult(sections.join("\n\n"));
}

const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function handleGithubStatus(args: any, apiKey: string) {
  const repo = String(args?.repo || "marlandoj/zouroboros").trim();
  if (!REPO_SLUG_REGEX.test(repo)) return toolResult("invalid repo slug (expected owner/name)", true);
  const cmd = `gh pr list -R ${repo} --limit 8 --state open; echo ---RUNS---; gh run list -R ${repo} --limit 5 2>/dev/null || echo 'no workflow runs'`;
  const r = await callZoMcp("bash", { cmd }, apiKey, 14_000);
  if (!r.ok) return toolResult(r.error, true);
  const m = r.text.match(/stdout='([\s\S]*?)', stderr=/);
  const stdout = (m ? m[1].replace(/\\n/g, "\n").replace(/\\t/g, "  ") : r.text).trim();
  if (!stdout) return toolResult(`No open PRs or runs found for ${repo}.`);
  const [prs, runs] = stdout.split("---RUNS---");
  const prBlock = (prs || "").trim() || "No open PRs.";
  const runBlock = (runs || "").trim() || "No recent workflow runs.";
  return toolResult(`${repo}\nOpen PRs:\n${prBlock}\n\nRecent CI runs:\n${runBlock}`.slice(0, 6000));
}

async function handleLinearIssueDetails(args: any) {
  const linearApiKey = process.env.LINEAR_API_KEY;
  if (!linearApiKey) {
    return toolResult("Linear is not configured. Add LINEAR_API_KEY in Zo Settings > Advanced > Secrets.", true);
  }
  const identifier = String(args?.identifier || "").trim().toUpperCase();
  if (!/^[A-Z]{2,10}-\d{1,6}$/.test(identifier)) return toolResult("invalid identifier (expected e.g. ZOU-1110)", true);
  const graphql = `
    query VoiceIssueDetails($id: String!) {
      issue(id: $id) {
        identifier title url updatedAt priorityLabel
        state { name }
        assignee { name }
        project { name }
        description
        comments(last: 3) { nodes { createdAt user { name } body } }
        relations(first: 8) { nodes { type relatedIssue { identifier title } } }
      }
    }
  `;
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: graphql, variables: { id: identifier } }),
  });
  const raw = await response.text();
  let payload: any;
  try { payload = JSON.parse(raw); } catch {
    return toolResult(`Linear returned a non-JSON response (HTTP ${response.status}).`, true);
  }
  if (!response.ok || payload?.errors?.length) {
    const detail = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    return toolResult(`Linear request failed: ${String(detail).slice(0, 300)}`, true);
  }
  const issue = payload?.data?.issue;
  if (!issue) return toolResult(`No Linear issue found for ${identifier}.`, true);
  const parts = [
    `${issue.identifier}: ${issue.title}`,
    `state: ${issue.state?.name || "?"}; assignee: ${issue.assignee?.name || "unassigned"}; priority: ${issue.priorityLabel || "none"}; project: ${issue.project?.name || "none"}; updated: ${String(issue.updatedAt || "").slice(0, 10)}`,
  ];
  if (issue.description) parts.push(`description: ${String(issue.description).replace(/\s+/g, " ").slice(0, 500)}`);
  const comments = Array.isArray(issue.comments?.nodes) ? issue.comments.nodes : [];
  if (comments.length) {
    parts.push("latest comments:");
    for (const comment of comments) {
      parts.push(`  - ${String(comment?.createdAt || "").slice(0, 10)} ${comment?.user?.name || "someone"}: ${String(comment?.body || "").replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  const relations = Array.isArray(issue.relations?.nodes) ? issue.relations.nodes : [];
  if (relations.length) {
    parts.push("related:");
    for (const rel of relations) {
      parts.push(`  - ${rel?.type || "related"}: ${rel?.relatedIssue?.identifier || "?"} ${String(rel?.relatedIssue?.title || "").slice(0, 60)}`);
    }
  }
  if (issue.url) parts.push(issue.url);
  return toolResult(parts.join("\n"));
}

async function handleDriveSearch(args: any, apiKey: string) {
  const rawQuery = String(args?.query || "").trim().slice(0, 200);
  if (!rawQuery) return toolResult("missing query", true);
  const maxResults = Math.min(Math.max(parseInt(args?.max_results ?? "10", 10) || 10, 1), 20);
  const isDriveQuery = /(^|\s)(name|fullText|mimeType|modifiedTime|trashed|parents|owners)\s*(contains|=|>|<)/.test(rawQuery);
  const escaped = rawQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = isDriveQuery ? rawQuery : `name contains '${escaped}' and trashed = false`;
  const r = await callZoMcp(
    "use_app_google_drive",
    { tool_name: "google_drive-search-files", configured_props: { query, includeItemsFromAllDrives: true } },
    apiKey,
    14_000,
  );
  if (!r.ok) return toolResult(r.error, true);
  return toolResult(r.text.slice(0, 6000).split("\n").slice(0, 6 + maxResults * 4).join("\n"));
}

const SERVICE_NAME_REGEX = /^[A-Za-z0-9._-]{1,80}$/;

async function handleServiceLogs(args: any, apiKey: string) {
  const service = String(args?.service || "").trim();
  if (!SERVICE_NAME_REGEX.test(service)) return toolResult("invalid service name", true);
  const lines = Math.min(Math.max(parseInt(args?.lines ?? "60", 10) || 60, 10), 200);
  const suffix = args?.stream === "err" ? "_err" : "";
  const cmd = `f=/dev/shm/${service}${suffix}.log; if [ -f "$f" ]; then tail -n ${lines} "$f" | tail -c 5000; else echo "no log file $f"; ls /dev/shm/*.log 2>/dev/null | head -30; fi`;
  const r = await callZoMcp("bash", { cmd }, apiKey, 12_000);
  if (!r.ok) return toolResult(r.error, true);
  const m = r.text.match(/stdout='([\s\S]*?)', stderr=/);
  const stdout = (m ? m[1].replace(/\\n/g, "\n") : r.text).trim();
  return toolResult(stdout ? `${service}${suffix}.log (last ${lines} lines):\n${stdout}`.slice(0, 6000) : `Log for ${service} is empty.`);
}

const ZO_ASK_ENDPOINT = "https://api.zo.computer/zo/ask";

async function handleAlaricQuery(args: any, apiKey: string) {
  const question = String(args?.question || "").trim().slice(0, 2000);
  if (!question) return toolResult("missing question", true);
  const candidates = [...new Set([apiKey, process.env.ZO_ASK_TOKEN].filter((v): v is string => !!v))];
  if (!candidates.length) return toolResult("ZO_API_KEY not configured", true);
  const input = [
    "You are handling a delegated question from Alaric Voice, the user's realtime voice assistant.",
    "Answer in at most 4 short sentences, optimized to be read aloud. Lead with the answer.",
    "This is a READ-ONLY request: do not create, edit, send, delete, deploy, or execute anything that changes state.",
    "If answering would require a write or long-running job, instead say what you would do and what approval is needed.",
    "",
    `Question: ${question}`,
  ].join("\n");
  let lastFailure = "no token accepted";
  for (const token of candidates) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 38_000);
    try {
      const resp = await fetch(ZO_ASK_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ input }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const raw = await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        lastFailure = `HTTP ${resp.status} ${raw.slice(0, 120)}`;
        continue;
      }
      if (!resp.ok) return toolResult(`Alaric delegate failed: HTTP ${resp.status} ${raw.slice(0, 200)}`, true);
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { return toolResult(`Alaric delegate returned non-JSON: ${raw.slice(0, 200)}`, true); }
      const output = typeof parsed?.output === "string" ? parsed.output : JSON.stringify(parsed?.output ?? parsed);
      return toolResult(output.slice(0, 4000));
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError") return toolResult("Alaric delegate timed out after 38s. Ask me to follow up by email for the full answer.", true);
      return toolResult(`Alaric delegate error: ${err?.message || "unknown"}`, true);
    }
  }
  return toolResult(`Alaric delegate failed: ${lastFailure}`, true);
}

async function handleCreateAgent(args: any, apiKey: string) {
  const name = String(args?.name || "").trim();
  const instructions = String(args?.instructions || "").trim();
  const rrule = String(args?.rrule || "").trim();
  if (!name || !instructions || !rrule) return toolResult("name, instructions, rrule all required", true);
  return passthrough("create_agent", { instruction: `${name}\n\n${instructions}`, rrule, model: "byok:461d8d6f-9616-4391-960e-3caea2a27829" }, apiKey, 30_000);
}

async function handleEditAgent(args: any, apiKey: string) {
  const agent_id = String(args?.agent_id || "").trim();
  if (!agent_id) return toolResult("missing agent_id", true);
  const params: Record<string, unknown> = { automation_id: agent_id };
  if (args?.instructions) params.instruction = String(args.instructions);
  return passthrough("edit_agent", params, apiKey, 30_000);
}

async function handleCreateAutomation(args: any, apiKey: string) {
  const name = String(args?.name || "").trim();
  const prompt = String(args?.prompt || "").trim();
  const rrule = String(args?.rrule || "").trim();
  if (!name || !prompt || !rrule) return toolResult("name, prompt, rrule all required", true);
  return passthrough("create_automation", { instruction: `${name}\n\n${prompt}`, rrule, model: "byok:461d8d6f-9616-4391-960e-3caea2a27829" }, apiKey, 30_000);
}

async function handleEditAutomation(args: any, apiKey: string) {
  const automation_id = String(args?.automation_id || "").trim();
  if (!automation_id) return toolResult("missing automation_id", true);
  const params: Record<string, unknown> = { automation_id };
  if (args?.prompt) params.instruction = String(args.prompt);
  return passthrough("edit_automation", params, apiKey, 30_000);
}

async function handleWriteSpaceRoute(args: any, apiKey: string) {
  const path = String(args?.path || "").trim();
  const route_type = String(args?.route_type || "").trim();
  const code = String(args?.code || "");
  if (!path.startsWith("/")) return toolResult("path must start with /", true);
  if (!["api", "page"].includes(route_type)) return toolResult("route_type must be 'api' or 'page'", true);
  if (!code) return toolResult("missing code", true);
  return passthrough("write_space_route", { path, route_type, code }, apiKey, 30_000);
}

async function handleEditSpaceRoute(args: any, apiKey: string) {
  const path = String(args?.path || "").trim();
  const code_edit = String(args?.code_edit || "");
  if (!path.startsWith("/")) return toolResult("path must start with /", true);
  if (!code_edit) return toolResult("missing code_edit", true);
  return passthrough("edit_space_route", { path, code_edit }, apiKey, 30_000);
}

async function handlePublishSite(args: any, apiKey: string) {
  const site_path = String(args?.site_path || "").trim();
  if (!site_path.startsWith("/home/workspace/")) return toolResult("site_path must start with /home/workspace/", true);
  return passthrough("publish_site", { site_path }, apiKey, 60_000);
}

// =========================================================================
// DISPATCHER
// =========================================================================

// Zo MCP tools that are read-only / idempotent, so re-running one after a
// transient upstream failure can never double-apply a side effect. Every
// mutating tool is intentionally ABSENT — writes (send_email, create_agent,
// write_space_route, generate_image, bash, …) stay one-shot.
const RETRYABLE_TOOLS = new Set<string>([
  "list_open_loops", "memory_search", "list_agents", "list_automations",
  "list_calendar_events", "read_file", "workspace_search", "web_search",
  "list_files", "list_personas", "list_user_services", "get_space_errors",
  "web_research", "find_similar_links", "maps_search", "read_webpage",
  "image_search", "save_webpage", "service_doctor", "gmail_search", "gmail_read",
  "linear_project_updates", "factory_status", "factory_run_details", "github_status",
  "linear_issue_details", "drive_search", "service_logs",
]);
const RETRY_BACKOFF_MS = 400;

// Only retry genuinely transient upstream failures (gateway/overload/timeout).
// Application errors, validation failures, and 4xx (other than 429) are not
// retried — a second identical call would fail the same way.
function isTransientErrorText(text: string): boolean {
  return /HTTP (?:429|502|503|504)\b/.test(text) || /Timed out after \d+ms/.test(text);
}

async function dispatchTool(name: string, args: any, apiKey: string) {
  const first = await dispatchToolOnce(name, args, apiKey);
  if (
    RETRYABLE_TOOLS.has(name) &&
    first?.isError &&
    isTransientErrorText(first.content?.[0]?.text ?? "")
  ) {
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    return await dispatchToolOnce(name, args, apiKey);
  }
  return first;
}

async function dispatchToolOnce(name: string, args: any, apiKey: string) {
  switch (name) {
    case "list_open_loops": return await handleListOpenLoops(args, apiKey);
    case "memory_search": return await handleMemorySearch(args, apiKey);
    case "list_agents": return await handleListAgents(args, apiKey);
    case "list_automations": return await handleListAutomations(args, apiKey);
    case "list_calendar_events": return await handleListCalendarEvents(args, apiKey);
    case "send_email": return await handleSendEmail(args, apiKey);
    case "send_sms": return await handleSendSms(args, apiKey);
    case "read_file": return await handleReadFile(args, apiKey);
    case "workspace_search": return await handleWorkspaceSearch(args, apiKey);
    case "web_search": return await handleWebSearch(args, apiKey);
    case "list_files": return await handleListFiles(args, apiKey);
    case "list_personas": return await handleListPersonas(args, apiKey);
    case "list_user_services": return await handleListUserServices(args, apiKey);
    case "get_space_errors": return await handleGetSpaceErrors(args, apiKey);
    case "web_research": return await handleWebResearch(args, apiKey);
    case "find_similar_links": return await handleFindSimilarLinks(args, apiKey);
    case "maps_search": return await handleMapsSearch(args, apiKey);
    case "read_webpage": return await handleReadWebpage(args, apiKey);
    case "image_search": return await handleImageSearch(args, apiKey);
    case "generate_image": return await handleGenerateImage(args, apiKey);
    case "save_webpage": return await handleSaveWebpage(args, apiKey);
    case "transcribe_audio": return await handleTranscribeAudio(args, apiKey);
    case "transcribe_video": return await handleTranscribeVideo(args, apiKey);
    case "service_doctor": return await handleServiceDoctor(args, apiKey);
    case "gmail_search": return await handleGmailSearch(args, apiKey);
    case "gmail_read": return await handleGmailRead(args, apiKey);
    case "linear_project_updates": return await handleLinearProjectUpdates(args);
    case "factory_status": return await handleFactoryStatus(args);
    case "factory_run_details": return await handleFactoryRunDetails(args);
    case "github_status": return await handleGithubStatus(args, apiKey);
    case "linear_issue_details": return await handleLinearIssueDetails(args);
    case "drive_search": return await handleDriveSearch(args, apiKey);
    case "service_logs": return await handleServiceLogs(args, apiKey);
    case "alaric_query": return await handleAlaricQuery(args, apiKey);
    case "calendar_create_event": return await handleCalendarCreateEvent(args, apiKey);
    case "set_active_persona": return await handleSetActivePersona(args, apiKey);
    case "create_agent": return await handleCreateAgent(args, apiKey);
    case "edit_agent": return await handleEditAgent(args, apiKey);
    case "create_automation": return await handleCreateAutomation(args, apiKey);
    case "edit_automation": return await handleEditAutomation(args, apiKey);
    case "write_space_route": return await handleWriteSpaceRoute(args, apiKey);
    case "edit_space_route": return await handleEditSpaceRoute(args, apiKey);
    case "publish_site": return await handlePublishSite(args, apiKey);
    default:
      return toolResult(`Unknown tool: ${name}`, true);
  }
}

// =========================================================================
// MAIN HANDLER (JSON-RPC 2.0 over HTTP)
// =========================================================================

export default async (c: Context): Promise<Response> => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Mcp-Token, Mcp-Session-Id, Mcp-Protocol-Version, MCP-Protocol-Version, Accept",
        "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (c.req.method === "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }

  if (c.req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", "Access-Control-Allow-Origin": "*" },
    });
  }

  const ip = getClientIp(c);
  if (!rateLimit(ip)) {
    return jsonRpcError(null, -32000, "Rate limited");
  }

  const MCP_TOKEN_ENV = "{{MCP_TOKEN_ENV}}";
  const expected = process.env[MCP_TOKEN_ENV];
  if (!expected) {
    return jsonRpcError(null, -32002, `${MCP_TOKEN_ENV} not configured in Zo Secrets`);
  }
  const customAuth = c.req.header("x-mcp-token") || "";
  const bearerAuth = c.req.header("authorization") || "";
  const queryToken = c.req.query("t") || "";
  let token = "";
  if (customAuth) {
    token = customAuth;
  } else if (bearerAuth.startsWith("Bearer ")) {
    token = bearerAuth.slice(7);
  } else if (queryToken) {
    token = queryToken;
  } else {
    return jsonRpcError(null, -32001, "Unauthorized (send X-Mcp-Token, Authorization: Bearer, or ?t= query)");
  }
  if (!constantTimeEqual(token, expected)) {
    return jsonRpcError(null, -32001, "Invalid token");
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const id = (body?.id ?? null) as JsonRpcId;
  const method = String(body?.method || "");
  const params = body?.params || {};

  if (method === "initialize") {
    const requestedVersion = String((params as any)?.protocolVersion || "");
    const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : DEFAULT_PROTOCOL_VERSION;
    return jsonRpcOk(
      id,
      {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "alaric-mcp", version: "1.2.0" },
      },
      {
        "Mcp-Session-Id": randomUUID(),
        "MCP-Protocol-Version": negotiatedVersion,
      },
    );
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204 });
  }

  if (method === "tools/list") {
    return jsonRpcOk(id, { tools: TOOL_DEFINITIONS });
  }

  if (method === "tools/call") {
    const toolName = String(params?.name || "");
    const toolArgs = params?.arguments || {};
    const apiKey = process.env.ZO_API_KEY;
    if (!apiKey) return jsonRpcOk(id, toolResult("ZO_API_KEY not configured", true));
    try {
      const TOOL_HARD_CAPS_MS: Record<string, number> = {
        list_personas: 20_000,
        github_status: 16_000,
        drive_search: 16_000,
        service_logs: 14_000,
        alaric_query: 40_000,
      };
      const REALTIME_HARD_CAP_MS = TOOL_HARD_CAPS_MS[toolName] ?? 10_000;
      const result = await Promise.race([
        dispatchTool(toolName, toolArgs, apiKey),
        new Promise<ReturnType<typeof toolResult>>((resolve) =>
          setTimeout(
            () => resolve(toolResult("That's taking longer than real-time allows. I'll send the result via SMS once it completes — ask me to follow up.", false)),
            REALTIME_HARD_CAP_MS,
          )
        ),
      ]);
      return jsonRpcOk(id, result);
    } catch (err: any) {
      console.error(`[alaric-mcp] tool error ${toolName}:`, err);
      return jsonRpcOk(id, toolResult(`Tool error: ${err?.message || "unknown"}`, true));
    }
  }

  if (method === "ping") {
    return jsonRpcOk(id, {});
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
};
