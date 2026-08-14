#!/usr/bin/env bun
/**
 * agent-doctor.ts — Zouroboros Agent Doctor
 *
 * Periodic diagnostic that audits scheduled agents for:
 *   1. cost-fitness:       Model tier vs task complexity mismatch
 *   2. frequency-waste:    Runs producing no meaningful output delta
 *   3. zombie-agents:      Agents for completed/stale projects
 *   4. duplicates:         Overlapping schedules and similar instructions
 *   5. tool-errors:        Recent tool-call failures from model/instruction mismatch
 *   6. persona-fitness:    Persona vs task alignment (claimed vs actual)
 *   7. instruction-hygiene: Stale file paths, deprecated components
 *   8. schedule-collision: Concurrent agents competing for resources
 *   9. delivery-method:    Internal agents sending unnecessary notifications
 *  10. instruction-length: Complex instructions on budget models
 *  11. output-delta:       Consecutive runs producing no new value
 *
 * Report-only by default. Does not mutate agents.
 *
 * Usage:
 *   bun doctor.ts [diagnose|cost|frequency|zombies|duplicates|errors|personas|hygiene|collisions|delivery|length|delta|summary]
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

// ── Types ───────────────────────────────────────────────────────────

interface AgentInfo {
  id: string;
  title: string;
  instruction: string;
  model: string;
  active: boolean;
  rrule: string;
  nextRun: string | null;
  deliveryMethod: string | null;
  rruleHour: number | null;
  rruleMinute: number | null;
}

interface Finding {
  check: string;
  severity: "critical" | "warning" | "info";
  agentId: string;
  agentTitle: string;
  message: string;
  recommendation: string;
}

interface ModelTiers {
  tiers: Record<string, { maxCostPer1kInput: number; models: string[]; labels: string[] }>;
  taskComplexity: Record<string, { description: string; recommendedTier: string; signals: string[] }>;
  downgradeDefaults: { bannedModelFallback: string; byTier: Record<string, string> };
  bannedAgentModels?: Record<string, string>;
}

interface PersonaInfo {
  name: string;
  id: string;
}

// ── Persona task-type mapping ────────────────────────────────────────
// Maps persona names to the agent task types they're suited for.
const PERSONA_TASK_AFFINITY: Record<string, string[]> = {
  "Memory Manager": ["memory", "capture", "decay", "embedding", "sync", "knowledge-promoter", "cross-db-sync"],
  "Security Engineer": ["security", "patches", "credential", "audit", "vulnerability"],
  "Project Shepherd": ["project", "status", "backlog", "check-in", "progress"],
  "Senior Project Manager": ["project", "status", "planning", "roadmap", "check-in"],
  "Studio Operations": ["supplier", "sourcing", "studio", "production"],
  "Video Producer": ["video", "content calendar", "produce"],
  "Marketing Content Creator": ["social media", "content", "marketing", "post"],
  "DevOps Automator": ["deploy", "infrastructure", "ci/cd", "monitoring"],
  "Zouroboros Engineer": ["zouroboros", "self-enhancement", "pipeline", "seed", "benchmark"],
  "Infrastructure Maintainer": ["vault", "indexer", "infrastructure", "server"],
  "Mimir": ["knowledge", "synthesis", "2nd brain", "sage"],
};

// ── Config ──────────────────────────────────────────────────────────

const ZO_MCP_API = "https://api.zo.computer/mcp";
const TIERS_PATH = join(import.meta.dir, "../assets/model-tiers.json");
const LOKI_URL = "http://localhost:3100";
const PROJECT_PATTERNS = [
  /file ['"]?([^'"]+PROJECT_PLAN\.md)/i,
  /\/home\/workspace\/([^\s]+PROJECT_PLAN\.md)/i,
  /Projects\/([^\s/]+)/i,
];

// ── Apply Mode Config ──────────────────────────────────────────────────────
// Agents that must NEVER be auto-modified (safety infrastructure / self).
const SAFETY_EXCLUDE_IDS = new Set<string>([
  "01a6df7e-6bd4-4772-bfe4-d04404106b8b", // Agent Doctor itself (prevent self-modification)
  "14cfe6a6-105e-4160-bf95-a93e95f871a0", // Model Healer (safety infrastructure)
]);

// Model-routing IDs are externalized to model-tiers.json (operator byok config, gitignored per
// ZOU-465 / D8). loadTiers() is a hoisted function declaration, so it is safe to call here.
const ROUTING = loadTiers();

// Models that MUST NOT be used for scheduled agents.
// These return empty output via the /zo/ask API — every run silently produces nothing.
// Only haiku, sonnet, and opus (Claude Code BYOK) are confirmed agent-safe.
const BANNED_AGENT_MODELS = new Map<string, string>(Object.entries(ROUTING.bannedAgentModels ?? {}));
// Cheapest confirmed agent-safe fallback for any banned-model agent.
const BANNED_MODEL_FALLBACK = ROUTING.downgradeDefaults.bannedModelFallback; // Claude Code Haiku

// Title patterns for agent pairs that are intentionally similar but NOT duplicates.
// Any pair where BOTH titles match a pattern here will be skipped in duplicate detection.
const DUPLICATE_EXEMPT_PATTERNS: RegExp[] = [
  /^\[[A-Z]{2,4}\] Rebalance/i, // Each Rebalance agent manages a distinct portfolio — similarity is expected
];

// Set to true to disable schedule-collision findings. LLM providers handle concurrent
// API calls gracefully; staggering is not required for this fleet.
const SUPPRESS_SCHEDULE_COLLISION = true;

// Default model id per tier for downgrades. Sourced from model-tiers.json (downgradeDefaults.byTier).
const TIER_DEFAULT_MODEL: Record<string, string> = ROUTING.downgradeDefaults.byTier;

interface AppliedAction {
  agentId: string;
  agentTitle: string;
  field: string;
  before: string;
  after: string;
  reason: string;
  check: string;
}

interface SkippedAction {
  agentId: string;
  agentTitle: string;
  check: string;
  message: string;
  recommendation: string;
  reason: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`);
}

function getAuthToken(): string {
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set");
  return token;
}

async function mcpCall(toolName: string, args: Record<string, any>): Promise<string> {
  const token = getAuthToken();
  const resp = await fetch(ZO_MCP_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  if (!resp.ok) throw new Error(`MCP ${toolName} HTTP ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as any;
  if (data.error) throw new Error(`MCP ${toolName} failed: ${data.error.message}`);
  return data.result?.content?.[0]?.text || "";
}

function loadTiers(): ModelTiers {
  return JSON.parse(readFileSync(TIERS_PATH, "utf-8"));
}

function getModelTier(model: string, tiers: ModelTiers): string {
  for (const [tierName, tier] of Object.entries(tiers.tiers)) {
    if (tier.models.includes(model)) return tierName;
  }
  return "unknown";
}

function getModelLabel(model: string, tiers: ModelTiers): string {
  for (const tier of Object.values(tiers.tiers)) {
    const idx = tier.models.indexOf(model);
    if (idx >= 0) return tier.labels[idx] || model;
  }
  return model;
}

const TIER_RANK: Record<string, number> = { budget: 0, standard: 1, premium: 2, expensive: 3 };

function classifyTask(instruction: string, tiers: ModelTiers): { type: string; recommendedTier: string } {
  const lower = instruction.toLowerCase();
  let bestMatch = { type: "unknown", recommendedTier: "standard", score: 0 };

  for (const [taskType, config] of Object.entries(tiers.taskComplexity)) {
    let score = 0;
    for (const signal of config.signals) {
      const regex = new RegExp(signal, "i");
      if (regex.test(lower)) score++;
    }
    if (score > bestMatch.score) {
      bestMatch = { type: taskType, recommendedTier: config.recommendedTier, score };
    }
  }
  return bestMatch;
}

function runsPerDay(rrule: string): number {
  const lines = rrule.split("\n");
  const ruleLine = lines.find((l) => l.startsWith("RRULE:")) || lines.find((l) => l.includes("FREQ=")) || "";
  const rule = ruleLine.replace("RRULE:", "");

  const freq = rule.match(/FREQ=(\w+)/)?.[1] || "";
  const interval = parseInt(rule.match(/INTERVAL=(\d+)/)?.[1] || "1");
  const byDay = rule.match(/BYDAY=([A-Z,]+)/)?.[1]?.split(",") || [];

  switch (freq) {
    case "MINUTELY": return (60 / interval) * 24;
    case "HOURLY": return 24 / interval;
    case "DAILY": return 1 / interval;
    case "WEEKLY": return (byDay.length || 1) / (7 * interval);
    case "MONTHLY": return 1 / (30 * interval);
    default: return 0;
  }
}

function instructionSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return intersection / Math.min(wordsA.size, wordsB.size);
}

// ── Agent Parser ────────────────────────────────────────────────────

function parseAgents(raw: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const entries = raw.split(/(?=id='[0-9a-f-]+')/);

  for (const entry of entries) {
    const id = entry.match(/id='([^']+)'/)?.[1];
    const title = entry.match(/title='([^']+)'/)?.[1];
    const instruction = entry.match(/instruction='([\s\S]*?)'\s+(?:created_at|rrule)/)?.[1] || "";
    const model = entry.match(/model='([^']+)'/)?.[1] || "";
    const active = entry.includes("active=True");
    const rrule = entry.match(/rrule='([^']+)'/)?.[1]?.replace(/\\n/g, "\n") || "";
    const nextRun = entry.match(/next_run=datetime\.datetime\(([^)]+)\)/)?.[1] || null;
    const delivery = entry.match(/result_delivery_method='?(\w+)'?/)?.[1] || null;

    if (id && title) {
      const hour = rrule.match(/BYHOUR=(\d+)/)?.[1];
      const minute = rrule.match(/BYMINUTE=(\d+)/)?.[1];
      agents.push({
        id,
        title,
        instruction: instruction.replace(/\\n/g, "\n").replace(/\\\\/g, "\\"),
        model,
        active,
        rrule,
        nextRun: nextRun === "None" ? null : nextRun,
        deliveryMethod: delivery === "None" ? null : delivery,
        rruleHour: hour != null ? parseInt(hour) : null,
        rruleMinute: minute != null ? parseInt(minute) : null,
      });
    }
  }
  return agents;
}

// ── Diagnostic Checks ───────────────────────────────────────────────

function checkCostFitness(agents: AgentInfo[], tiers: ModelTiers): Finding[] {
  const findings: Finding[] = [];

  for (const agent of agents) {
    if (!agent.active) continue;

    const modelTier = getModelTier(agent.model, tiers);
    const task = classifyTask(agent.instruction, tiers);
    const modelRank = TIER_RANK[modelTier] ?? 1;
    const taskRank = TIER_RANK[task.recommendedTier] ?? 1;
    const overshoot = modelRank - taskRank;

    if (overshoot >= 2) {
      findings.push({
        check: "cost-fitness",
        severity: "critical",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `Model ${getModelLabel(agent.model, tiers)} (${modelTier}) is ${overshoot} tiers above recommended for ${task.type} (${task.recommendedTier})`,
        recommendation: `Downgrade to ${task.recommendedTier} tier`,
      });
    } else if (overshoot === 1) {
      findings.push({
        check: "cost-fitness",
        severity: "warning",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `Model ${getModelLabel(agent.model, tiers)} (${modelTier}) is 1 tier above recommended for ${task.type} (${task.recommendedTier})`,
        recommendation: `Consider downgrading to ${task.recommendedTier} tier`,
      });
    }
  }
  return findings;
}

function checkBannedModels(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];
  for (const agent of agents) {
    if (!agent.active) continue;
    const reason = BANNED_AGENT_MODELS.get(agent.model);
    if (reason) {
      findings.push({
        check: "banned-model",
        severity: "critical",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `Banned model in use: ${reason}`,
        recommendation: `Switch to Claude Haiku — cheapest confirmed agent-safe model`,
      });
    }
  }
  return findings;
}

function checkFrequencyWaste(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];

  for (const agent of agents) {
    if (!agent.active) continue;

    const rpd = runsPerDay(agent.rrule);

    if (rpd >= 12) {
      findings.push({
        check: "frequency-waste",
        severity: "warning",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `Runs ${rpd.toFixed(0)} times/day. High-frequency agents should have verified output deltas.`,
        recommendation: `Review recent logs. If output is static, reduce to every 4-6h.`,
      });
    }
  }
  return findings;
}

function checkZombieAgents(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];

  for (const agent of agents) {
    if (!agent.active) continue;

    // Check for COUNT-exhausted agents still marked active
    if (!agent.nextRun || agent.nextRun === "None") {
      findings.push({
        check: "zombie-agents",
        severity: "warning",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `No next_run scheduled (COUNT exhausted or schedule ended). Agent is active but will never fire.`,
        recommendation: `Deactivate this agent.`,
      });
      continue;
    }

    // Check for project plan references
    for (const pattern of PROJECT_PATTERNS) {
      const match = agent.instruction.match(pattern);
      if (match) {
        const planPath = match[1].startsWith("/") ? match[1] : `/home/workspace/${match[1]}`;
        if (existsSync(planPath)) {
          try {
            const content = readFileSync(planPath, "utf-8").toLowerCase();
            if (
              content.includes("status: ✅ complete") ||
              content.includes("status:** ✅ complete") ||
              content.includes("project complete") ||
              content.includes("status: complete")
            ) {
              findings.push({
                check: "zombie-agents",
                severity: "critical",
                agentId: agent.id,
                agentTitle: agent.title,
                message: `References ${planPath} which is marked COMPLETE.`,
                recommendation: `Deactivate — project is finished.`,
              });
            }
          } catch {}
        }
      }
    }
  }
  return findings;
}

function checkDuplicates(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];
  const active = agents.filter((a) => a.active);
  const seen = new Set<string>();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const key = [active[i].id, active[j].id].sort().join(":");
      if (seen.has(key)) continue;

      // Skip pairs that are intentionally similar (separate portfolios, etc.)
      const bothExempt = DUPLICATE_EXEMPT_PATTERNS.some(
        (pat) => pat.test(active[i].title) && pat.test(active[j].title)
      );
      if (bothExempt) continue;

      const sim = instructionSimilarity(active[i].instruction, active[j].instruction);
      if (sim > 0.6) {
        seen.add(key);
        findings.push({
          check: "duplicates",
          severity: sim > 0.8 ? "critical" : "warning",
          agentId: active[i].id,
          agentTitle: `${active[i].title} ↔ ${active[j].title}`,
          message: `${(sim * 100).toFixed(0)}% instruction overlap. Possible consolidation candidate.`,
          recommendation: `Review both agents for merge opportunity. Keep the one with better scheduling.`,
        });
      }
    }
  }
  return findings;
}

async function checkToolErrors(agents: AgentInfo[]): Promise<Finding[]> {
  const findings: Finding[] = [];

  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const url = new URL(`${LOKI_URL}/loki/api/v1/query_range`);
    url.searchParams.set(
      "query",
      '{filename="/dev/shm/wss.log"} |~ "invalid agent id|failed to parse function|missing field"'
    );
    url.searchParams.set("start", `${Math.floor(since / 1000)}000000000`);
    url.searchParams.set("end", `${Math.floor(Date.now() / 1000)}000000000`);
    url.searchParams.set("limit", "100");

    const resp = await fetch(url.toString());
    const data = (await resp.json()) as any;
    const values = data?.data?.result?.[0]?.values || [];

    if (values.length > 10) {
      // Group by error type
      const errorTypes = new Map<string, number>();
      for (const [, line] of values) {
        const match = (line as string).match(/error=(.+?)(?:\n|$)/);
        if (match) {
          const errType = match[1].substring(0, 60);
          errorTypes.set(errType, (errorTypes.get(errType) || 0) + 1);
        }
      }

      const topErrors = [...errorTypes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([err, count]) => `${err} (×${count})`)
        .join("; ");

      findings.push({
        check: "tool-errors",
        severity: values.length > 30 ? "critical" : "warning",
        agentId: "system",
        agentTitle: "ACP Tool Router",
        message: `${values.length} tool-call errors in last 24h. Top: ${topErrors}`,
        recommendation: `Check which agent model is generating malformed tool calls. Likely a budget model that can't handle Zo MCP tools correctly.`,
      });
    }
  } catch (e: any) {
    log(`Loki query failed: ${e.message}`);
  }

  return findings;
}

// ── New Diagnostic Checks (v2) ──────────────────────────────────────

function extractPersonaFromInstruction(instruction: string): string | null {
  // Match patterns like "You are the X persona", "Role: X", "X: Execute"
  const patterns = [
    /You are the ([A-Z][A-Za-z\s/]+?) persona/i,
    /You are the ([A-Z][A-Za-z\s/]+?)\./,
    /^([A-Z][A-Za-z\s]+?): (?:Execute|Run|Check|Send|Perform)/m,
    /ROLE: ([A-Z][A-Za-z\s/]+)/i,
  ];
  for (const p of patterns) {
    const m = instruction.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function checkPersonaFitness(agents: AgentInfo[], personas: PersonaInfo[]): Finding[] {
  const findings: Finding[] = [];
  const personaNames = new Set(personas.map((p) => p.name.toLowerCase()));

  for (const agent of agents) {
    if (!agent.active) continue;

    const claimed = extractPersonaFromInstruction(agent.instruction);
    if (!claimed) continue; // No persona claim — skip

    // Check if the claimed persona actually exists
    const claimedLower = claimed.toLowerCase();
    const exists = [...personaNames].some(
      (pn) => pn.includes(claimedLower) || claimedLower.includes(pn)
    );

    if (!exists) {
      findings.push({
        check: "persona-fitness",
        severity: "warning",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `Claims persona "${claimed}" but no matching persona exists in the system.`,
        recommendation: `Create the persona or update the instruction to use an existing one.`,
      });
      continue;
    }

    // Check affinity: does the persona match the task?
    for (const [personaName, keywords] of Object.entries(PERSONA_TASK_AFFINITY)) {
      if (claimedLower.includes(personaName.toLowerCase())) {
        const instrLower = agent.instruction.toLowerCase();
        const matchCount = keywords.filter((k) => instrLower.includes(k)).length;
        if (matchCount === 0) {
          findings.push({
            check: "persona-fitness",
            severity: "info",
            agentId: agent.id,
            agentTitle: agent.title,
            message: `Uses "${personaName}" persona but instruction doesn't match typical ${personaName} tasks.`,
            recommendation: `Verify this agent needs the ${personaName} persona or assign a better fit.`,
          });
        }
        break;
      }
    }
  }
  return findings;
}

function checkInstructionHygiene(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];

  for (const agent of agents) {
    if (!agent.active) continue;

    // Extract file paths from instruction
    const pathMatches = agent.instruction.match(/\/home\/workspace\/[^\s'"\\)]+/g) || [];
    const missingPaths: string[] = [];

    for (const p of pathMatches) {
      // Skip paths ending with '...' — list_automations truncates instructions at ~215 chars
      // and appends literal '...' as the truncation marker. If this marker changes, revisit.
      if (p.endsWith("...")) continue;
      // Clean trailing punctuation
      const clean = p.replace(/[.,;:!?]+$/, "");
      if (!existsSync(clean)) {
        missingPaths.push(clean);
      }
    }

    if (missingPaths.length > 0) {
      findings.push({
        check: "instruction-hygiene",
        severity: missingPaths.length > 2 ? "critical" : "warning",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `References ${missingPaths.length} missing path(s): ${missingPaths.slice(0, 3).join(", ")}`,
        recommendation: `Update instruction with correct paths or remove stale references.`,
      });
    }

    // Check for deprecated tool patterns
    const deprecatedPatterns = [
      { pattern: /omniroute/i, label: "OmniRoute (removed)" },
      { pattern: /cortexdb.*migrate/i, label: "CortexDB migration (completed)" },
    ];
    for (const { pattern, label } of deprecatedPatterns) {
      if (pattern.test(agent.instruction)) {
        findings.push({
          check: "instruction-hygiene",
          severity: "warning",
          agentId: agent.id,
          agentTitle: agent.title,
          message: `References deprecated component: ${label}`,
          recommendation: `Remove or update the stale reference.`,
        });
      }
    }
  }
  return findings;
}

function checkScheduleCollisions(agents: AgentInfo[]): Finding[] {
  if (SUPPRESS_SCHEDULE_COLLISION) return [];
  const findings: Finding[] = [];
  const active = agents.filter((a) => a.active && a.rruleHour != null);

  // Group by hour
  const byHour = new Map<number, AgentInfo[]>();
  for (const a of active) {
    const h = a.rruleHour!;
    const arr = byHour.get(h) || [];
    arr.push(a);
    byHour.set(h, arr);
  }

  for (const [hour, group] of byHour) {
    if (group.length < 3) continue; // 2 at same hour is fine

    // Check if they share resource domains (memory, filesystem)
    const memoryAgents = group.filter((a) =>
      /memory|decay|embed|sync|capture|knowledge/i.test(a.instruction)
    );

    if (memoryAgents.length >= 2) {
      findings.push({
        check: "schedule-collision",
        severity: "warning",
        agentId: memoryAgents.map((a) => a.id).join(","),
        agentTitle: memoryAgents.map((a) => a.title).join(" + "),
        message: `${memoryAgents.length} memory-related agents scheduled at hour ${hour}:00. Risk of SQLite WAL contention.`,
        recommendation: `Stagger by 15+ minutes or consolidate into a single pipeline agent.`,
      });
    }

    if (group.length >= 4) {
      findings.push({
        check: "schedule-collision",
        severity: "warning",
        agentId: "system",
        agentTitle: `Hour ${hour}:00 cluster`,
        message: `${group.length} agents fire at ${hour}:00: ${group.map((a) => a.title.substring(0, 30)).join(", ")}`,
        recommendation: `Stagger schedules to reduce concurrent session load.`,
      });
    }
  }
  return findings;
}

function checkDeliveryMethod(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];
  const internalKeywords = [
    "index", "embed", "decay", "sync", "capture", "vault",
    "pipeline", "ingestion", "backfill", "healer", "doctor",
  ];

  for (const agent of agents) {
    if (!agent.active) continue;

    const instrLower = agent.instruction.toLowerCase();
    const isInternal = internalKeywords.some((k) => instrLower.includes(k));
    const sendsNotification = agent.deliveryMethod === "email" || agent.deliveryMethod === "sms";

    if (isInternal && sendsNotification) {
      findings.push({
        check: "delivery-method",
        severity: "info",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `Internal maintenance agent sends ${agent.deliveryMethod}. Adds inbox noise for routine ops.`,
        recommendation: `Set delivery to 'none' and only escalate on failure (exit code != 0).`,
      });
    }
  }
  return findings;
}

function checkInstructionLength(agents: AgentInfo[], tiers: ModelTiers): Finding[] {
  const findings: Finding[] = [];

  for (const agent of agents) {
    if (!agent.active) continue;

    const modelTier = getModelTier(agent.model, tiers);
    const instrTokenEstimate = Math.ceil(agent.instruction.length / 4); // rough token estimate

    if (modelTier === "budget" && instrTokenEstimate > 500) {
      findings.push({
        check: "instruction-length",
        severity: instrTokenEstimate > 1000 ? "critical" : "warning",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `~${instrTokenEstimate} instruction tokens on budget model. Budget models degrade with complex instructions.`,
        recommendation: `Simplify instruction to <500 tokens or upgrade model to standard tier.`,
      });
    } else if (modelTier === "standard" && instrTokenEstimate > 1500) {
      findings.push({
        check: "instruction-length",
        severity: "info",
        agentId: agent.id,
        agentTitle: agent.title,
        message: `~${instrTokenEstimate} instruction tokens. Consider whether all detail is necessary.`,
        recommendation: `Review instruction for redundancy. Move static reference data to files.`,
      });
    }
  }
  return findings;
}

async function checkOutputDelta(agents: AgentInfo[]): Promise<Finding[]> {
  const findings: Finding[] = [];

  try {
    // Query Loki for agent sessions with identical consecutive outputs
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    const url = new URL(`${LOKI_URL}/loki/api/v1/query_range`);
    url.searchParams.set(
      "query",
      '{filename="/dev/shm/wss.log"} |~ "agent_session_complete|0 files|0 items|no changes|nothing to"'
    );
    url.searchParams.set("start", `${Math.floor(since / 1000)}000000000`);
    url.searchParams.set("end", `${Math.floor(Date.now() / 1000)}000000000`);
    url.searchParams.set("limit", "200");

    const resp = await fetch(url.toString());
    const data = (await resp.json()) as any;
    const values = data?.data?.result?.[0]?.values || [];

    if (values.length > 20) {
      findings.push({
        check: "output-delta",
        severity: "warning",
        agentId: "system",
        agentTitle: "Multiple agents",
        message: `${values.length} "no output" log entries in last 7 days. Some agents may be running without producing value.`,
        recommendation: `Cross-reference with frequency-waste findings. Consider reducing frequency for zero-delta agents.`,
      });
    }
  } catch (e: any) {
    log(`Loki output-delta query failed: ${e.message}`);
  }

  return findings;
}

// ── Reporting ───────────────────────────────────────────────────────

function formatReport(findings: Finding[], agents: AgentInfo[], tiers: ModelTiers): string {
  const lines: string[] = [];
  const activeCount = agents.filter((a) => a.active).length;
  const totalRpd = agents.filter((a) => a.active).reduce((sum, a) => sum + runsPerDay(a.rrule), 0);

  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("  ZOUROBOROS AGENT DOCTOR — DIAGNOSTIC REPORT");
  lines.push(`  ${new Date().toISOString().split("T")[0]}  |  ${activeCount} active agents  |  ${totalRpd.toFixed(0)} sessions/day`);
  lines.push("═══════════════════════════════════════════════════════════");

  if (findings.length === 0) {
    lines.push("\n  ✅ All agents healthy. No findings.\n");
    return lines.join("\n");
  }

  const critical = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");
  const infos = findings.filter((f) => f.severity === "info");

  lines.push(`\n  Findings: ${critical.length} critical, ${warnings.length} warnings, ${infos.length} info\n`);

  const byCheck = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byCheck.get(f.check) || [];
    arr.push(f);
    byCheck.set(f.check, arr);
  }

  const checkLabels: Record<string, string> = {
    "cost-fitness": "💰 COST FITNESS — Model tier vs task complexity",
    "frequency-waste": "🔁 FREQUENCY WASTE — Runs with low output delta",
    "zombie-agents": "💀 ZOMBIE AGENTS — Completed projects or exhausted schedules",
    duplicates: "🔀 DUPLICATES — Overlapping agents",
    "tool-errors": "🔧 TOOL ERRORS — Model/instruction mismatches",
    "persona-fitness": "🎭 PERSONA FITNESS — Persona vs task alignment",
    "instruction-hygiene": "📋 INSTRUCTION HYGIENE — Stale paths and deprecated references",
    "schedule-collision": "⏰ SCHEDULE COLLISION — Concurrent resource contention",
    "delivery-method": "📬 DELIVERY METHOD — Notification noise audit",
    "instruction-length": "📏 INSTRUCTION LENGTH — Complexity vs model capability",
    "output-delta": "📊 OUTPUT DELTA — Consecutive runs with no value",
    "banned-model": "🚫 BANNED MODEL — Model returns empty output via /zo/ask (Codex Mini, Gemini, non-Claude BYOK)",
  };

  for (const [check, label] of Object.entries(checkLabels)) {
    const checkFindings = byCheck.get(check);
    if (!checkFindings || checkFindings.length === 0) continue;

    lines.push(`\n  ${label}`);
    lines.push("  " + "─".repeat(55));

    for (const f of checkFindings) {
      const icon = f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
      lines.push(`  ${icon} ${f.agentTitle}`);
      lines.push(`     ${f.message}`);
      lines.push(`     → ${f.recommendation}`);
      if (f.agentId !== "system") lines.push(`     ID: ${f.agentId}`);
      lines.push("");
    }
  }

  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("  Report-only mode. No changes applied.");
  lines.push("  To act on findings, run edits manually or via the Healer.");
  lines.push("═══════════════════════════════════════════════════════════\n");

  return lines.join("\n");
}

function formatSummary(findings: Finding[]): string {
  if (findings.length === 0) return "Agent Doctor: ✅ All clear — 0 findings.";

  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  const lines = [`Agent Doctor: ${critical} critical, ${warnings} warnings`];
  for (const f of findings.filter((f) => f.severity === "critical")) {
    lines.push(`  🔴 [${f.check}] ${f.agentTitle}: ${f.message.substring(0, 80)}`);
  }
  for (const f of findings.filter((f) => f.severity === "warning").slice(0, 5)) {
    lines.push(`  🟡 [${f.check}] ${f.agentTitle}: ${f.message.substring(0, 80)}`);
  }
  return lines.join("\n");
}

// ── Apply Mode ─────────────────────────────────────────────────────────────

async function applyCorrections(
  findings: Finding[],
  agents: AgentInfo[],
  tiers: ModelTiers,
): Promise<{ applied: AppliedAction[]; skipped: SkippedAction[]; errors: string[] }> {
  const applied: AppliedAction[] = [];
  const skipped: SkippedAction[] = [];
  const errors: string[] = [];
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const deactivated = new Set<string>();

  const skip = (f: Finding, reason: string) =>
    skipped.push({
      agentId: f.agentId,
      agentTitle: f.agentTitle,
      check: f.check,
      message: f.message,
      recommendation: f.recommendation,
      reason,
    });

  // 1. Zombie deactivations (no next_run) — apply FIRST so we don't waste
  //    model/delivery edits on agents we're about to disable.
  for (const f of findings.filter((x) => x.check === "zombie-agents")) {
    if (SAFETY_EXCLUDE_IDS.has(f.agentId)) {
      skip(f, "Agent in safety exclude list");
      continue;
    }
    const agent = agentMap.get(f.agentId);
    if (!agent) {
      skip(f, "Agent not found in current snapshot");
      continue;
    }
    // Only auto-deactivate true no-next-run zombies (not heuristic project-complete).
    if (agent.nextRun) {
      skip(f, "Project-complete heuristic — manual review (work may not be truly done)");
      continue;
    }
    try {
      await mcpCall("edit_agent", { automation_id: agent.id, active: "false" });
      applied.push({
        agentId: agent.id,
        agentTitle: agent.title,
        field: "active",
        before: "true",
        after: "false",
        reason: f.message,
        check: f.check,
      });
      deactivated.add(agent.id);
    } catch (e: any) {
      errors.push(`Deactivate ${agent.title}: ${e.message}`);
    }
  }

  // 2. Banned-model fixes — switch to Haiku immediately (silent failure risk).
  for (const f of findings.filter((x) => x.check === "banned-model")) {
    if (deactivated.has(f.agentId)) continue;
    if (SAFETY_EXCLUDE_IDS.has(f.agentId)) {
      skip(f, "Agent in safety exclude list (self/infra)");
      continue;
    }
    const agent = agentMap.get(f.agentId);
    if (!agent) {
      skip(f, "Agent not found in current snapshot");
      continue;
    }
    if (agent.model === BANNED_MODEL_FALLBACK) {
      skip(f, "Already on fallback model (Haiku)");
      continue;
    }
    try {
      await mcpCall("edit_agent", { automation_id: agent.id, model: BANNED_MODEL_FALLBACK });
      applied.push({
        agentId: agent.id,
        agentTitle: agent.title,
        field: "model",
        before: agent.model,
        after: "Claude Code Haiku",
        reason: f.message,
        check: f.check,
      });
    } catch (e: any) {
      errors.push(`Fix banned model ${agent.title}: ${e.message}`);
    }
  }

  // 3. Cost-fitness downgrades.
  for (const f of findings.filter((x) => x.check === "cost-fitness")) {
    if (deactivated.has(f.agentId)) continue;
    if (SAFETY_EXCLUDE_IDS.has(f.agentId)) {
      skip(f, "Agent in safety exclude list (self/infra)");
      continue;
    }
    const agent = agentMap.get(f.agentId);
    if (!agent) {
      skip(f, "Agent not found in current snapshot");
      continue;
    }
    // Parse target tier from recommendation: "Downgrade to budget tier"
    const m = f.recommendation.match(/(?:to|tier)\s+(budget|standard|premium|expensive)/i);
    const targetTier = m?.[1]?.toLowerCase() || "";
    const targetModel = TIER_DEFAULT_MODEL[targetTier];
    if (!targetModel) {
      skip(f, `Could not parse target tier from recommendation: "${f.recommendation}"`);
      continue;
    }
    if (targetModel === agent.model) {
      skip(f, "Already on target model");
      continue;
    }
    try {
      await mcpCall("edit_agent", { automation_id: agent.id, model: targetModel });
      applied.push({
        agentId: agent.id,
        agentTitle: agent.title,
        field: "model",
        before: getModelLabel(agent.model, tiers),
        after: getModelLabel(targetModel, tiers),
        reason: f.message,
        check: f.check,
      });
    } catch (e: any) {
      errors.push(`Downgrade ${agent.title}: ${e.message}`);
    }
  }

  // 4. Delivery-method (silence internal noise).
  for (const f of findings.filter((x) => x.check === "delivery-method")) {
    if (deactivated.has(f.agentId)) continue;
    if (SAFETY_EXCLUDE_IDS.has(f.agentId)) {
      skip(f, "Agent in safety exclude list (self/infra)");
      continue;
    }
    const agent = agentMap.get(f.agentId);
    if (!agent) {
      skip(f, "Agent not found in current snapshot");
      continue;
    }
    if (agent.deliveryMethod === "none" || agent.deliveryMethod == null) {
      skip(f, "Already silenced (delivery=none)");
      continue;
    }
    try {
      await mcpCall("edit_agent", { automation_id: agent.id, delivery_method: "none" });
      applied.push({
        agentId: agent.id,
        agentTitle: agent.title,
        field: "delivery_method",
        before: agent.deliveryMethod || "(unset)",
        after: "none",
        reason: f.message,
        check: f.check,
      });
    } catch (e: any) {
      errors.push(`Silence ${agent.title}: ${e.message}`);
    }
  }

  // 4. All other checks — auto-apply not supported, flag for manual review.
  const autoChecks = new Set(["zombie-agents", "cost-fitness", "delivery-method"]);
  for (const f of findings.filter((x) => !autoChecks.has(x.check))) {
    skip(f, "Auto-apply not supported for this check — manual review required");
  }

  return { applied, skipped, errors };
}

function formatApplyReport(
  findings: Finding[],
  agents: AgentInfo[],
  tiers: ModelTiers,
  applied: AppliedAction[],
  skipped: SkippedAction[],
  errors: string[],
): string {
  const lines: string[] = [];
  const activeCount = agents.filter((a) => a.active).length;
  const totalRpd = agents.filter((a) => a.active).reduce((sum, a) => sum + runsPerDay(a.rrule), 0);

  lines.push("══════════════════════════════════════════════════════════════════");
  lines.push("  ZOUROBOROS AGENT DOCTOR — APPLY REPORT");
  lines.push(`  ${new Date().toISOString().split("T")[0]}  |  ${activeCount} active agents  |  ${totalRpd.toFixed(0)} sessions/day`);
  lines.push("══════════════════════════════════════════════════════════════════");

  if (findings.length === 0) {
    lines.push("\n  ✅ All agents healthy. No findings, no changes applied.\n");
    return lines.join("\n");
  }

  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;

  lines.push(`\n  Findings: ${critical} critical, ${warnings} warnings, ${infos} info`);
  lines.push(`  Applied: ${applied.length}   Skipped: ${skipped.length}   Errors: ${errors.length}\n`);

  // ── Applied actions ──────────────────────────────────────────────────────
  if (applied.length > 0) {
    lines.push("  ✅ APPLIED CORRECTIONS");
    lines.push("  " + "─".repeat(60));
    for (const a of applied) {
      lines.push(`  • ${a.agentTitle}`);
      lines.push(`     [${a.check}] ${a.field}: ${a.before} → ${a.after}`);
      lines.push(`     Reason: ${a.reason}`);
      lines.push(`     ID: ${a.agentId}`);
      lines.push("");
    }
  }

  // ── Errors ───────────────────────────────────────────────────────────────
  if (errors.length > 0) {
    lines.push("  ❌ ERRORS DURING APPLY");
    lines.push("  " + "─".repeat(60));
    for (const e of errors) lines.push(`  • ${e}`);
    lines.push("");
  }

  // ── Skipped (grouped by check) ───────────────────────────────────────────
  if (skipped.length > 0) {
    lines.push("  ⚠️  MANUAL REVIEW REQUIRED");
    lines.push("  " + "─".repeat(60));
    const byCheck = new Map<string, SkippedAction[]>();
    for (const s of skipped) {
      const arr = byCheck.get(s.check) || [];
      arr.push(s);
      byCheck.set(s.check, arr);
    }
    for (const [check, arr] of byCheck) {
      lines.push(`\n  [${check}] — ${arr.length} item(s)`);
      for (const s of arr) {
        lines.push(`  • ${s.agentTitle}`);
        lines.push(`     ${s.message}`);
        lines.push(`     → ${s.recommendation}`);
        lines.push(`     Skip reason: ${s.reason}`);
        if (s.agentId !== "system") lines.push(`     ID: ${s.agentId}`);
        lines.push("");
      }
    }
  }

  lines.push("══════════════════════════════════════════════════════════════════");
  lines.push(`  Apply mode complete. ${applied.length} change(s) committed.`);
  lines.push("══════════════════════════════════════════════════════════════════\n");

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────

function parsePersonas(raw: string): PersonaInfo[] {
  const personas: PersonaInfo[] = [];
  const nameMatches = raw.matchAll(/name='([^']+)'/g);
  const idMatches = raw.matchAll(/id='([^']+)'/g);
  const names = [...nameMatches].map((m) => m[1]);
  const ids = [...idMatches].map((m) => m[1]);
  for (let i = 0; i < Math.min(names.length, ids.length); i++) {
    personas.push({ name: names[i], id: ids[i] });
  }
  return personas;
}

async function main() {
  const command = process.argv[2] || "diagnose";
  const tiers = loadTiers();

  log(`Agent Doctor v2 — command: ${command}`);
  log("Fetching agents and personas...");

  const [rawAgents, rawPersonas] = await Promise.all([
    mcpCall("list_agents", {}),
    mcpCall("list_personas", {}),
  ]);
  const agents = parseAgents(rawAgents);
  const personas = parsePersonas(rawPersonas);
  log(`Parsed ${agents.length} agents (${agents.filter((a) => a.active).length} active), ${personas.length} personas`);

  let findings: Finding[] = [];

  const checks: Record<string, () => Promise<Finding[]> | Finding[]> = {
    banned: () => checkBannedModels(agents),
    cost: () => checkCostFitness(agents, tiers),
    frequency: () => checkFrequencyWaste(agents),
    zombies: () => checkZombieAgents(agents),
    duplicates: () => checkDuplicates(agents),
    errors: () => checkToolErrors(agents),
    personas: () => checkPersonaFitness(agents, personas),
    hygiene: () => checkInstructionHygiene(agents),
    collisions: () => checkScheduleCollisions(agents),
    delivery: () => checkDeliveryMethod(agents),
    length: () => checkInstructionLength(agents, tiers),
    delta: () => checkOutputDelta(agents),
  };

  if (command === "diagnose" || command === "summary" || command === "apply") {
    for (const [name, check] of Object.entries(checks)) {
      log(`Running check: ${name}`);
      const results = await check();
      findings.push(...results);
    }
  } else if (checks[command]) {
    findings = (await checks[command]()) as Finding[];
  } else {
    console.error(`Unknown command: ${command}`);
    console.error(
      "Usage: bun doctor.ts [diagnose|apply|banned|cost|frequency|zombies|duplicates|errors|personas|hygiene|collisions|delivery|length|delta|summary]",
    );
    process.exit(1);
  }

  if (command === "summary") {
    console.log(formatSummary(findings));
    process.exit(findings.length > 0 ? 2 : 0);
  }

  if (command === "apply") {
    log(`Applying corrections for ${findings.length} findings...`);
    const { applied, skipped, errors } = await applyCorrections(findings, agents, tiers);
    console.log(formatApplyReport(findings, agents, tiers, applied, skipped, errors));
    // Exit code: 0 = clean OR clean apply, 2 = changes applied or skipped items remain, 1 = error
    if (errors.length > 0) process.exit(1);
    process.exit(findings.length > 0 ? 2 : 0);
  }

  console.log(formatReport(findings, agents, tiers));
  process.exit(findings.length > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
