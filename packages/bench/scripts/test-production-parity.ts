#!/usr/bin/env bun
/**
 * Production Parity Test — ZouroBench
 *
 * Validates that production MCP tools return real results against the live DB.
 * Tests structural + data parity: same CLI paths, real production data.
 */

const MCP_BASE = "http://localhost:48402";
const SHARED_DB = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

async function callTool(tool: string, args: Record<string, unknown>): Promise<{ result: string; error?: string }> {
  const r = await fetch(`${MCP_BASE}/tools/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  }).catch(() => null);
  if (!r || !r.ok) return { result: "", error: `HTTP ${r?.status}` };
  const data = await r.json();
  return { result: data.result || "", error: data.error };
}

interface Check {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  expect: (result: string) => boolean;
  desc: string;
}

const CHECKS: Check[] = [
  // Tool 1: memory_fact_search
  {
    id: "fs-01", tool: "memory_fact_search",
    args: { query: "ETF trading strategy", limit: 3 },
    expect: (r) => r.length > 50 && r.includes("["),
    desc: "fact_search returns ETF strategy facts",
  },
  {
    id: "fs-02", tool: "memory_fact_search",
    args: { query: "Zouroboros memory system", limit: 3 },
    expect: (r) => r.length > 50,
    desc: "fact_search returns Zouroboros memory facts",
  },
  // Tool 2: memory_procedure_retrieve
  {
    id: "pr-01", tool: "memory_procedure_retrieve",
    args: { name: "introspect" },
    expect: (r) => r.length > 0,
    desc: "procedure_retrieve lists procedures (may be empty)",
  },
  // Tool 3: memory_episode_retrieve
  {
    id: "ep-01", tool: "memory_episode_retrieve",
    args: { limit: 5 },
    expect: (r) => r.length > 50 && r.includes("success"),
    desc: "episode_retrieve returns recent episodes",
  },
  {
    id: "ep-02", tool: "memory_episode_retrieve",
    args: { outcome: "success", limit: 3 },
    expect: (r) => r.length > 0,
    desc: "episode_retrieve filters by outcome",
  },
  // Tool 4: memory_cross_persona_search
  {
    id: "cp-01", tool: "memory_cross_persona_search",
    args: { persona: "alaric", query: "trading", limit: 3 },
    expect: (r) => typeof r === "string",
    desc: "cross_persona_search returns string result (empty ok if no pool data)",
  },
  // Tool 5: memory_swarm_dag_retrieve
  {
    id: "sd-01", tool: "memory_swarm_dag_retrieve",
    args: { recent: 5 },
    expect: (r) => typeof r === "string" && r.length >= 0,
    desc: "swarm_dag_retrieve returns string result",
  },
  // Tool 6: memory_hybrid_deep
  {
    id: "hd-01", tool: "memory_hybrid_deep",
    args: { question: "wheel strategy ETF options paper trading", top_k: 3 },
    expect: (r) => r.length > 50,
    desc: "hybrid_deep returns results for complex question",
  },
  {
    id: "hd-02", tool: "memory_hybrid_deep",
    args: { question: "Zouroboros health council monitoring", top_k: 3 },
    expect: (r) => r.length > 50,
    desc: "hybrid_deep returns Zouroboros system facts",
  },
];

async function main() {
  console.log("═".repeat(60));
  console.log("ZouroBench Production Parity Test");
  console.log("═".repeat(60));

  // Check MCP server health
  const health = await fetch(`${MCP_BASE}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error("❌ MCP server not running on port 48402");
    process.exit(1);
  }
  const info = await health.json();
  console.log(`  Server: ${info.status} | Tools: ${info.tools?.length} | DB: ${info.db_exists ? "✅" : "❌"}`);
  console.log(`  DB path: ${info.db}`);
  console.log(`  Checks: ${CHECKS.length}\n`);

  let total = 0, pass = 0;
  for (const check of CHECKS) {
    total++;
    const { result, error } = await callTool(check.tool, check.args);
    const ok = !error && check.expect(result);
    if (ok) pass++;
    const icon = ok ? "✅" : (error ? "❌" : "⚠️");
    console.log(`  ${icon} ${check.id} | ${check.desc}`);
    if (error) console.log(`     ERROR: ${error}`);
    else if (!ok) console.log(`     Got: "${result.slice(0, 80)}"`);
  }

  const pct = Math.round((pass / total) * 100);
  console.log("\n" + "═".repeat(60));
  console.log(`PARITY: ${pct}% (${pass}/${total})`);
  console.log(pct >= 75 ? "✅ PASS — Production parity achieved" : "⚠️ Below threshold — check tool implementations");
  console.log("═".repeat(60));

  if (pct < 75) process.exit(1);
}

main().catch(console.error);
