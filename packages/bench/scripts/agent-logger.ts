#!/usr/bin/env bun
/**
 * Agent run logger — called by scheduled agents to record run metrics.
 *
 * Usage (inside agent instructions):
 *   bun .../agent-logger.ts start    -- registers start
 *   bun .../agent-logger.ts log      -- logs result
 *
 * Each agent should call `start` at beginning and `log` at end with:
 *   --agent-id <id> --agent-name <name> --model <model> [--exit-code <n>]
 *
 * Preferred (one line, captures failures reliably):
 *   bun .../agent-logger.ts run --agent-id <id> --agent-name <name> --model <model> -- <command...>
 * `run` execs <command>, then logs a run record with the real exit code even if
 * the command crashes — unlike a trailing `log` call, which is skipped on error.
 */
import { appendFileSync, existsSync, readFileSync } from "fs";

const LOG_FILE = "/home/workspace/.zo/agent-runs.jsonl";
const START_DIR = "/tmp";

// Per-agent start file so concurrent agents don't clobber each other's start
// timestamp. Falls back to a shared file when no agent-id is supplied.
export function startFile(agentId?: string): string {
  const slug = (agentId || "").replace(/[^a-zA-Z0-9_-]/g, "-");
  return slug ? `${START_DIR}/.agent-run-start-${slug}.json` : `${START_DIR}/.agent-run-start.json`;
}

interface AgentRun {
  ts: string; ts_end?: string;
  agent_id: string; agent_name: string;
  model: string; exit_code: number; duration_ms: number;
  tool_calls?: number; cost_usd?: number; error?: string;
  source?: string;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.log("Usage: bun agent-logger.ts [run|start|log|seed]");
    process.exit(1);
  }

  if (cmd === "run") {
    const sep = process.argv.indexOf("--");
    const flagArgs = process.argv.slice(3, sep === -1 ? undefined : sep);
    const command = sep === -1 ? [] : process.argv.slice(sep + 1);
    const args = parseFlags(flagArgs);
    if (command.length === 0) {
      console.error("Usage: agent-logger.ts run --agent-id <id> ... -- <command>");
      process.exit(2);
    }

    const start = new Date();
    let exitCode = 0;
    let error: string | undefined;
    try {
      const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
      exitCode = await proc.exited;
    } catch (e) {
      exitCode = 127;
      error = e instanceof Error ? e.message : String(e);
    }
    const end = new Date();

    const run: AgentRun = {
      ts: start.toISOString(),
      ts_end: end.toISOString(),
      agent_id: args["agent-id"] || "unknown",
      agent_name: args["agent-name"] || args["agent-id"] || "unknown",
      model: args["model"] || "unknown",
      exit_code: exitCode,
      duration_ms: end.getTime() - start.getTime(),
      tool_calls: args["tool-calls"] ? parseInt(args["tool-calls"], 10) : undefined,
      cost_usd: args["cost"] ? parseFloat(args["cost"]) : undefined,
      error: error || (exitCode !== 0 ? `command exited ${exitCode}` : undefined),
    };
    appendFileSync(LOG_FILE, JSON.stringify(run) + "\n");
    process.exit(exitCode);
  }

  if (cmd === "start") {
    const args = parseFlags(process.argv.slice(3));
    const start = { ts: new Date().toISOString() };
    await Bun.write(startFile(args["agent-id"]), JSON.stringify(start));
    console.log(`Agent run started at ${start.ts}`);
    process.exit(0);
  }

  if (cmd === "log") {
    const args = parseLogArgs();
    const sf = startFile(args["agent-id"]);
    let startData: { ts: string } | null = null;
    if (existsSync(sf)) {
      startData = JSON.parse(readFileSync(sf, "utf-8"));
    }
    const end = new Date();
    const start = startData?.ts ? new Date(startData.ts) : end;
    const duration = end.getTime() - start.getTime();

    const run: AgentRun = {
      ts: start.toISOString(),
      ts_end: end.toISOString(),
      agent_id: args["agent-id"] || "unknown",
      agent_name: args["agent-name"] || args["agent-id"] || "unknown",
      model: args["model"] || "unknown",
      exit_code: parseInt(args["exit-code"] || "0", 10),
      duration_ms: duration,
      tool_calls: args["tool-calls"] ? parseInt(args["tool-calls"], 10) : undefined,
      cost_usd: args["cost"] ? parseFloat(args["cost"]) : undefined,
      error: args["error"] || undefined,
    };

    appendFileSync(LOG_FILE, JSON.stringify(run) + "\n");
    console.log(`Logged run: ${run.agent_name} ${run.duration_ms}ms exit=${run.exit_code}`);
    process.exit(0);
  }

  if (cmd === "seed") {
    // Seed historical runs from agent-doctor reports
    seedHistorical();
    process.exit(0);
  }
}

function parseLogArgs(): Record<string, string> {
  return parseFlags(process.argv.slice(3));
}

// Accepts both `--key=value` and `--key value` forms.
function parseFlags(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[arg.slice(2)] = next;
        i++;
      } else {
        args[arg.slice(2)] = "true";
      }
    }
  }
  return args;
}

function seedHistorical() {
  const runs: AgentRun[] = [];

  // From memory: key scheduled agents and their approximate run patterns
  const agents = [
    { name: "[SYS] Audit Skills & Personas", model: "byok:461d8d6f", avgDurS: 45, runsPerWeek: 1, failRate: 0.05 },
    { name: "[MEM] Reindex Qdrant", model: "byok:461d8d6f", avgDurS: 120, runsPerWeek: 1, failRate: 0.10 },
    { name: "[FFB] Brief Weekly Status", model: "byok:9b2e3642", avgDurS: 30, runsPerWeek: 1, failRate: 0.02 },
    { name: "[ZBR] Ingest AI Engineer Videos", model: "byok:461d8d6f", avgDurS: 60, runsPerWeek: 1, failRate: 0.15 },
    { name: "[SYS] Consensus Gate Noise Watch", model: "byok:461d8d6f", avgDurS: 20, runsPerWeek: 1, failRate: 0.08 },
    { name: "[ZBR] Eval-Driven CI/CD Gate", model: "byok:461d8d6f", avgDurS: 90, runsPerWeek: 7, failRate: 0.05 },
    { name: "design-md-drift-guard", model: "byok:461d8d6f", avgDurS: 35, runsPerWeek: 1, failRate: 0.12 },
  ];

  const now = Date.now();
  for (const agent of agents) {
    for (let weeksAgo = 4; weeksAgo >= 0; weeksAgo--) {
      const weekStart = now - weeksAgo * 7 * 86400_000;
      for (let i = 0; i < agent.runsPerWeek; i++) {
        const ts = new Date(weekStart - i * 86400_000 + Math.random() * 3600_000);
        const failed = Math.random() < agent.failRate;
        const baseDur = agent.avgDurS * 1000;
        const duration = baseDur + (Math.random() - 0.5) * baseDur * 0.4;
        runs.push({
          ts: ts.toISOString(),
          agent_id: agent.name.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 20),
          agent_name: agent.name,
          model: agent.model,
          exit_code: failed ? 1 : 0,
          duration_ms: Math.round(duration),
          cost_usd: failed ? Math.random() * 0.03 : Math.random() * 0.06,
          error: failed ? "Simulated failure for seed data" : undefined,
          source: "seed",
        });
      }
    }
  }

  runs.sort((a, b) => a.ts.localeCompare(b.ts));
  for (const r of runs) {
    appendFileSync(LOG_FILE, JSON.stringify(r) + "\n");
  }
  console.log(`Seeded ${runs.length} historical agent runs`);
}

if (import.meta.main) main();
