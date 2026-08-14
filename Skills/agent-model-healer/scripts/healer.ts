#!/usr/bin/env bun
/**
 * Zouroboros Agent Model Healer v2
 *
 * Fully autonomous self-healing watchdog. Runs as a cron job — zero AI model cost
 * for orchestration. Only the probe calls use /zo/ask (minimal tokens).
 * All agent management (list, edit) and notifications use direct MCP calls.
 *
 * Commands:
 *   probe       — Test all configured models, output health status
 *   diagnose    — List agents grouped by model, flag unhealthy ones
 *   status      — Show current healer state (active switches, last probe)
 *   auto        — Full autonomous pipeline: probe → list → heal/restore → notify (for cron)
 *   run         — Legacy: probe + output instructions (kept for manual use)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const CONFIG_PATH = "/home/workspace/Skills/agent-model-healer/assets/fallback-chain.json";
const STATE_PATH = "/home/workspace/.zouroboros/healer-state.json";
const LOG_PATH = "/dev/shm/agent-model-healer.log";
const ZO_ASK_API = "https://api.zo.computer/zo/ask";
const ZO_MCP_API = "https://api.zo.computer/mcp";

type ProbeHealth = "healthy" | "degraded" | "unhealthy";

export type RungType = "proprietary" | "open-weight" | "zo-native" | "unknown";

const TERMINAL_ZO_MODELS = new Set(["zo:smart", "zo:fast"]);
const VERCEL_OPEN_WEIGHT_PREFIXES = ["vercel:moonshotai/", "vercel:minimax/", "vercel:meta/", "vercel:meta-llama/", "vercel:qwen/", "vercel:deepseek/"];
const OPEN_WEIGHT_LABEL_HINTS = ["gpt-oss", "kimi", "moonshot", " k2", "k2.", "qwen", "deepseek", "llama", "minimax"];
const PROPRIETARY_LABEL_HINTS = ["claude", "sonnet", "haiku", "opus", "gpt-", "codex", "gemini"];

export function classifyRung(model: string, label?: string): RungType {
  if (TERMINAL_ZO_MODELS.has(model)) return "zo-native";
  if (VERCEL_OPEN_WEIGHT_PREFIXES.some((p) => model.startsWith(p))) return "open-weight";
  const hay = (label || model).toLowerCase();
  // Open-weight label hints take precedence over proprietary hints so that
  // BYOK rungs like "BYOK Kimi K2.6 (synthetic.new)" classify correctly.
  if (OPEN_WEIGHT_LABEL_HINTS.some((h) => hay.includes(h))) return "open-weight";
  if (PROPRIETARY_LABEL_HINTS.some((h) => hay.includes(h))) return "proprietary";
  return "unknown";
}

export interface ChainValidationResult { ok: boolean; errors: string[]; warnings: string[]; }

export function validateChain(config: FallbackConfig): ChainValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chains = config.fallbackChains;
  const knownPrimaries = new Set(Object.keys(chains));

  if (knownPrimaries.has(config.healerConfig.model)) {
    errors.push(`Healer model '${config.healerConfig.model}' must remain outside every monitored fallback chain`);
  }

  for (const [primary, chain] of Object.entries(chains)) {
    const primaryRung = classifyRung(primary, chain.label);

    // Empty fallbacks: only allowed if the primary itself is an acceptable
    // terminal floor (open-weight or zo-native). Exhaustion then triggers an
    // alert email rather than a cascade.
    if (chain.fallbacks.length === 0) {
      if (primaryRung !== "open-weight" && primaryRung !== "zo-native") {
        errors.push(`Chain '${chain.label || primary}' has empty fallbacks but primary rung is '${primaryRung}' (expected open-weight or zo-native)`);
      }
    } else {
      const last = chain.fallbacks[chain.fallbacks.length - 1];
      const lastRung = classifyRung(last, config.modelLabels[last] || (chains[last]?.label));
      if (lastRung !== "open-weight" && lastRung !== "zo-native") {
        errors.push(`Chain '${primary}' terminal rung is '${last}' (rung:${lastRung}); expected open-weight or zo-native`);
      }
      for (const fb of chain.fallbacks) {
        if (!knownPrimaries.has(fb) && !TERMINAL_ZO_MODELS.has(fb)) {
          errors.push(`Chain '${primary}' fallback '${fb}' is neither a registered primary nor a terminal zo:* model`);
        }
      }
      // Q2 #6 invariant: proprietary chains must include ≥1 open-weight rung
      // before terminal exhaustion (whether terminal is zo-native or open-weight).
      if (primaryRung === "proprietary") {
        const hasOpenWeight = chain.fallbacks.some((m) => classifyRung(m, config.modelLabels[m] || chains[m]?.label) === "open-weight");
        if (!hasOpenWeight) errors.push(`Proprietary chain '${chain.label || primary}' lacks an open-weight rung before terminal exhaustion (Q2 #6 invariant)`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

interface ProbeResult {
  model: string;
  healthy: boolean;
  health: ProbeHealth;
  latencyMs: number;
  error?: string;
  warning?: string;
  checkedAt: string;
}

interface SwitchRecord {
  agentId: string;
  agentTitle: string;
  originalModel: string;
  currentModel: string;
  switchedAt: string;
  reason: string;
}

interface HealerState {
  switches: SwitchRecord[];
  lastProbe: Record<string, ProbeResult>;
  lastRunAt: string;
  healCount: number;
  restoreCount: number;
  lastHeartbeatAt?: string;
}

interface FallbackConfig {
  healerConfig: { model: string; label: string; rule: string };
  probeConfig: {
    prompt: string;
    expectedSubstring: string;
    timeoutMs: number;
    retries: number;
    latencyThresholds: { degradedMs: number; slowMs: number };
  };
  fallbackChains: Record<string, { label: string; fallbacks: string[] }>;
  modelLabels: Record<string, string>;
}

interface AgentInfo {
  id: string;
  title: string;
  model: string;
  active: boolean;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
  try {
    const existing = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf-8") : "";
    const lines = existing.split("\n");
    const trimmed = lines.length > 500 ? lines.slice(-400).join("\n") : existing;
    writeFileSync(LOG_PATH, trimmed + line);
  } catch {}
}

function getAuthToken(): string {
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set");
  return token;
}

function loadConfig(): FallbackConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function loadState(): HealerState {
  if (!existsSync(STATE_PATH)) {
    return { switches: [], lastProbe: {}, lastRunAt: "", healCount: 0, restoreCount: 0 };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
}

function saveState(state: HealerState) {
  mkdirSync("/home/workspace/.zouroboros", { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getModelLabel(model: string, config: FallbackConfig): string {
  return config.modelLabels[model] || model;
}

// ── MCP Direct Calls (zero model cost) ──────────────────────────────

async function mcpCall(toolName: string, args: Record<string, any>, timeoutMs = 45000): Promise<any> {
  const token = getAuthToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ZO_MCP_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });

    const data = await resp.json() as any;
    return unwrapMcpResult(data, toolName);
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`MCP ${toolName} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function unwrapMcpResult(data: any, toolName: string): string {
  if (data?.error) {
    throw new Error(`MCP ${toolName} failed: ${data.error.message}`);
  }
  const content = Array.isArray(data?.result?.content) ? data.result.content : [];
  const text = content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text || ""))
    .join("\n");
  if (data?.result?.isError) {
    throw new Error(`MCP ${toolName} failed: ${text || "tool returned an error"}`);
  }
  return text;
}

async function mcpListAgents(): Promise<AgentInfo[]> {
  log("Fetching automations via MCP list_automations...");
  const raw = await mcpCall("list_automations", {});
  return parseAgents(raw);
}

async function mcpEditAgent(agentId: string, model: string): Promise<string> {
  log(`MCP edit_automation: ${agentId} → ${model}`);
  return await mcpCall("edit_automation", { automation_id: agentId, model });
}

async function mcpSendEmail(subject: string, body: string): Promise<void> {
  log(`Sending notification email: ${subject}`);
  try {
    await mcpCall("send_email_to_user", { subject, markdown_body: body });
  } catch (err: any) {
    log(`Email send failed: ${err.message}`);
  }
}

// ── Probe (uses /zo/ask — hardened v2) ──────────────────────────────

function classifyLatency(ms: number, thresholds: { degradedMs: number; slowMs: number }): { health: ProbeHealth; warning?: string } {
  if (ms >= thresholds.slowMs) return { health: "degraded", warning: `Slow response: ${ms}ms (threshold: ${thresholds.slowMs}ms)` };
  if (ms >= thresholds.degradedMs) return { health: "degraded", warning: `Elevated latency: ${ms}ms (threshold: ${thresholds.degradedMs}ms)` };
  return { health: "healthy" };
}

function parseBalanceFromError(body: string): string | undefined {
  const balanceMatch = body.match(/can only afford (\d+)/i);
  const requestedMatch = body.match(/requested up to (\d+)/i);
  if (balanceMatch) {
    const remaining = balanceMatch[1];
    const requested = requestedMatch?.[1] || "unknown";
    return `Remaining balance: ${remaining} tokens (requested: ${requested})`;
  }
  const creditMatch = body.match(/requires more credits/i);
  if (creditMatch) return "Provider reports insufficient credits";
  return undefined;
}

async function probeModel(model: string, config: FallbackConfig): Promise<ProbeResult> {
  const token = getAuthToken();
  const { prompt, expectedSubstring, timeoutMs, retries, latencyThresholds } = config.probeConfig;
  let lastError = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(ZO_ASK_API, {
        method: "POST",
        headers: {
          authorization: token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: prompt, model_name: model }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      if (resp.ok) {
        const data = await resp.json() as any;
        const output: string = (data.output || "").toString();

        // Validate output content
        if (!output || output.trim().length === 0) {
          return {
            model, healthy: false, health: "unhealthy", latencyMs,
            error: "Empty response — model returned no output",
            checkedAt: new Date().toISOString(),
          };
        }

        if (expectedSubstring && !output.toLowerCase().includes(expectedSubstring.toLowerCase())) {
          // Output doesn't contain expected content — degraded (might be incoherent)
          const { health, warning: latWarn } = classifyLatency(latencyMs, latencyThresholds);
          return {
            model, healthy: true, health: "degraded", latencyMs,
            warning: `Output validation failed: expected "${expectedSubstring}" not found in response. ${latWarn || ""}`.trim(),
            checkedAt: new Date().toISOString(),
          };
        }

        // Content valid — check latency
        const { health, warning } = classifyLatency(latencyMs, latencyThresholds);
        return { model, healthy: true, health, latencyMs, warning, checkedAt: new Date().toISOString() };

      } else {
        const body = await resp.text().catch(() => "");
        const balanceInfo = parseBalanceFromError(body);
        lastError = `HTTP ${resp.status}: ${body.slice(0, 300)}`;
        if (balanceInfo) lastError += ` [${balanceInfo}]`;

        if (resp.status >= 400) {
          return {
            model, healthy: false, health: "unhealthy",
            latencyMs: Date.now() - start,
            error: lastError, checkedAt: new Date().toISOString(),
          };
        }
      }
    } catch (err: any) {
      lastError = err.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : err.message;
    }
  }

  return { model, healthy: false, health: "unhealthy", latencyMs: 0, error: lastError, checkedAt: new Date().toISOString() };
}

// ── Agent Parsing ───────────────────────────────────────────────────

function parseAgents(raw: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const entries = raw.split(/(?=id=')/);
  for (const entry of entries) {
    const idMatch = /id='([^']+)'/.exec(entry);
    const titleMatch = /title='([^']+)'/.exec(entry);
    const modelMatch = /model='([^']+)'/.exec(entry);
    const activeMatch = /active=(True|False)/.exec(entry);
    if (idMatch && modelMatch) {
      agents.push({
        id: idMatch[1],
        title: titleMatch?.[1] || "Untitled",
        model: modelMatch[1],
        active: activeMatch?.[1] !== "False",
      });
    }
  }
  return agents;
}

// ── Commands ────────────────────────────────────────────────────────

async function cmdProbe() {
  const config = loadConfig();
  const state = loadState();
  const uniqueModels = new Set<string>(Object.keys(config.fallbackChains));

  log(`Probing ${uniqueModels.size} models...`);
  const results: ProbeResult[] = [];

  for (const model of uniqueModels) {
    log(`  Probing ${getModelLabel(model, config)}...`);
    const result = await probeModel(model, config);
    results.push(result);
    state.lastProbe[model] = result;
    const icon = result.health === "healthy" ? "✅" : result.health === "degraded" ? "⚠️" : "❌";
    const detail = result.error || result.warning || "";
    const status = `${icon} ${result.health.toUpperCase()}${detail ? `: ${detail}` : ""}`;
    log(`  ${getModelLabel(model, config)}: ${status} (${result.latencyMs}ms)`);
  }

  state.lastRunAt = new Date().toISOString();
  saveState(state);
  console.log(JSON.stringify({ command: "probe", results }, null, 2));
}

async function cmdDiagnose() {
  const config = loadConfig();
  const state = loadState();
  const unhealthyModels = Object.entries(state.lastProbe)
    .filter(([, p]) => !p.healthy)
    .map(([model, p]) => ({
      model, label: getModelLabel(model, config), error: p.error, lastChecked: p.checkedAt,
    }));

  console.log(JSON.stringify({
    command: "diagnose", unhealthyModels,
    activeSwitches: state.switches.length, lastRunAt: state.lastRunAt,
  }, null, 2));
}

async function cmdStatus() {
  const config = loadConfig();
  const state = loadState();

  const unhealthy = Object.entries(state.lastProbe)
    .filter(([, p]) => !p.healthy)
    .map(([model, p]) => ({ model, label: getModelLabel(model, config), health: p.health, error: p.error, checkedAt: p.checkedAt }));

  const degraded = Object.entries(state.lastProbe)
    .filter(([, p]) => p.healthy && p.health === "degraded")
    .map(([model, p]) => ({ model, label: getModelLabel(model, config), warning: p.warning, latencyMs: p.latencyMs, checkedAt: p.checkedAt }));

  const healthy = Object.entries(state.lastProbe)
    .filter(([, p]) => p.healthy && p.health === "healthy")
    .map(([model, p]) => ({ model, label: getModelLabel(model, config), latencyMs: p.latencyMs, checkedAt: p.checkedAt }));

  console.log(JSON.stringify({
    command: "status",
    lastRunAt: state.lastRunAt,
    totalHeals: state.healCount,
    totalRestores: state.restoreCount,
    activeSwitches: state.switches.map((s) => ({
      agentId: s.agentId, agentTitle: s.agentTitle,
      original: getModelLabel(s.originalModel, config),
      current: getModelLabel(s.currentModel, config),
      switchedAt: s.switchedAt, reason: s.reason,
    })),
    unhealthyModels: unhealthy,
    degradedModels: degraded,
    healthyModels: healthy,
  }, null, 2));
}

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function maybeSendHeartbeat(state: HealerState, config: FallbackConfig) {
  const now = Date.now();
  const lastBeat = state.lastHeartbeatAt ? new Date(state.lastHeartbeatAt).getTime() : 0;
  if (now - lastBeat < HEARTBEAT_INTERVAL_MS) return;

  const probes = Object.entries(state.lastProbe);
  const healthy = probes.filter(([, p]) => p.healthy && p.health === "healthy").length;
  const degraded = probes.filter(([, p]) => p.healthy && p.health === "degraded").length;
  const unhealthy = probes.filter(([, p]) => !p.healthy).length;
  const onFallback = state.switches.length;

  const subject = `💓 Model Healer Heartbeat — ${healthy}✅ ${degraded}⚠️ ${unhealthy}❌`;
  const body = `
<p>Daily heartbeat from the Zouroboros Model Healer. If you stop receiving this, the healer or Zo platform is down.</p>
<p><strong>Models:</strong> ${healthy} healthy, ${degraded} degraded, ${unhealthy} unhealthy</p>
<p><strong>Agents on fallback:</strong> ${onFallback}</p>
<p><strong>Lifetime:</strong> ${state.healCount} heals, ${state.restoreCount} restores</p>
<p><em>— Zouroboros Model Healer (heartbeat, every 24h)</em></p>
`.trim();

  await mcpSendEmail(subject, body);
  state.lastHeartbeatAt = new Date().toISOString();
  log("Heartbeat email sent.");
}

/**
 * Fully autonomous pipeline — designed for cron.
 * Zero AI model cost for orchestration. Only probes use /zo/ask.
 */
async function cmdAuto() {
  log("=== Healer Auto Run (v2 — cron mode) ===");
  const config = loadConfig();

  // Q2 #6 invariant: validate chain shape before any healing decision.
  // A misshapen chain (missing terminal, dangling fallback, proprietary tier
  // without open-weight rung) means we'd flip agents to bad targets.
  const validation = validateChain(config);
  if (!validation.ok) {
    log(`Chain validation FAILED — aborting auto run. Errors: ${validation.errors.join(" | ")}`);
    console.error(JSON.stringify({ command: "auto", phase: "validation_failed", errors: validation.errors }, null, 2));
    process.exit(2);
  }

  const state = loadState();

  // Step 0: Reconcile state.switches with live agent state.
  // If an agent's model no longer matches our recorded currentModel, the user
  // manually reassigned it — drop the switch record so we stop probing dead
  // originalModels and stop lying about "agents on fallback".
  let agents: AgentInfo[] | null = null;
  if (state.switches.length > 0) {
    try {
      agents = await mcpListAgents();
    } catch (err: any) {
      log(`Failed to list agents at reconcile: ${err.message}`);
      console.log(JSON.stringify({ phase: "error", error: err.message }));
      return;
    }
    log(`Fetched ${agents.length} agents for reconcile.`);

    const beforeCount = state.switches.length;
    state.switches = state.switches.filter(sw => {
      const live = agents!.find(a => a.id === sw.agentId);
      if (!live) {
        log(`Reconcile: drop — agent ${sw.agentTitle} (${sw.agentId}) no longer exists`);
        return false;
      }
      if (live.model !== sw.currentModel) {
        log(`Reconcile: drop — agent ${sw.agentTitle} manually reassigned ${sw.currentModel} → ${live.model}`);
        return false;
      }
      return true;
    });
    if (beforeCount !== state.switches.length) {
      log(`Reconcile: ${beforeCount} → ${state.switches.length} switches (${beforeCount - state.switches.length} stale records dropped)`);
    }

    // Prune orphan lastProbe entries — models no longer referenced by any chain or switch.
    const validModels = new Set<string>(Object.keys(config.fallbackChains));
    for (const sw of state.switches) {
      validModels.add(sw.originalModel);
      validModels.add(sw.currentModel);
    }
    validModels.add("zo:smart");
    validModels.add("zo:fast");
    const beforeProbe = Object.keys(state.lastProbe).length;
    for (const m of Object.keys(state.lastProbe)) {
      if (!validModels.has(m)) delete state.lastProbe[m];
    }
    const afterProbe = Object.keys(state.lastProbe).length;
    if (beforeProbe !== afterProbe) {
      log(`Reconcile: pruned ${beforeProbe - afterProbe} orphan probe records`);
    }
    saveState(state);
  }

  // Step 1: Probe all models
  const uniqueModels = new Set<string>(Object.keys(config.fallbackChains));
  for (const sw of state.switches) uniqueModels.add(sw.originalModel);

  log(`Probing ${uniqueModels.size} models...`);
  for (const model of uniqueModels) {
    const result = await probeModel(model, config);
    state.lastProbe[model] = result;
    const icon = result.health === "healthy" ? "✅" : result.health === "degraded" ? "⚠️" : "❌";
    const detail = result.error || result.warning || "";
    log(`  ${icon} ${getModelLabel(model, config)} (${result.latencyMs}ms)${detail ? ` — ${detail}` : ""}`);
  }
  state.lastRunAt = new Date().toISOString();
  saveState(state);

  const unhealthy = Object.entries(state.lastProbe).filter(([, p]) => !p.healthy);

  if (unhealthy.length === 0 && state.switches.length === 0) {
    log("All models healthy. No switches active. Nothing to do.");
    await maybeSendHeartbeat(state, config);
    saveState(state);
    console.log(JSON.stringify({ phase: "complete", healActions: [], restoreActions: [], summary: "All healthy." }));
    return;
  }

  // Step 2: Fetch agents via direct MCP if we didn't already at reconcile (zero model cost)
  if (!agents) {
    try {
      agents = await mcpListAgents();
    } catch (err: any) {
      log(`Failed to list agents: ${err.message}`);
      console.log(JSON.stringify({ phase: "error", error: err.message }));
      return;
    }
    log(`Fetched ${agents.length} agents.`);
  }

  // WATCHMEN INDEPENDENCE RULE: Never heal yourself.
  // Hardcoded ID + title match — env vars die at process boundaries.
  const HEALER_AGENT_ID = "14cfe6a6-105e-4160-bf95-a93e95f871a0";
  const HEALER_TITLE_PATTERN = /model healer/i;

  const unhealthySet = new Set(unhealthy.map(([m]) => m));
  const healActions: Array<{ agentId: string; agentTitle: string; from: string; to: string; reason: string }> = [];
  const restoreActions: Array<{ agentId: string; agentTitle: string; from: string; to: string }> = [];
  const exhaustedAlerts: Array<{ agentId: string; agentTitle: string; model: string; modelLabel: string; chainLabels: string[]; reason: string }> = [];

  // Step 3: Heal — switch agents on unhealthy models
  for (const agent of agents) {
    if (!agent.active) continue;
    if (agent.id === HEALER_AGENT_ID || HEALER_TITLE_PATTERN.test(agent.title)) {
      log(`Skipping self: ${agent.title} (${agent.id})`);
      continue;
    }
    if (state.switches.find((s) => s.agentId === agent.id)) continue;
    if (!unhealthySet.has(agent.model)) continue;

    const chain = config.fallbackChains[agent.model];
    if (!chain) { log(`No fallback chain for ${agent.model} — skipping ${agent.title}`); continue; }

    let targetModel: string | null = null;
    for (const fb of chain.fallbacks) {
      const probe = state.lastProbe[fb];
      if (!probe) {
        const result = await probeModel(fb, config);
        state.lastProbe[fb] = result;
        if (result.healthy) { targetModel = fb; break; }
      } else if (probe.healthy) { targetModel = fb; break; }
    }

    // Chain exhausted — policy (v6) is alert-on-exhaustion, not cascade to zo:smart.
    if (!targetModel) {
      const baseReason = state.lastProbe[agent.model]?.error || "unhealthy";
      exhaustedAlerts.push({
        agentId: agent.id,
        agentTitle: agent.title,
        model: agent.model,
        modelLabel: getModelLabel(agent.model, config),
        chainLabels: chain.fallbacks.map((m) => getModelLabel(m, config)),
        reason: baseReason,
      });
      log(`EXHAUSTED: no healthy fallback for ${agent.title} (${getModelLabel(agent.model, config)}) — alert-only per v6 policy`);
      continue;
    }

    const targetRung = classifyRung(targetModel, getModelLabel(targetModel, config));
    const baseReason = state.lastProbe[agent.model]?.error || "unhealthy";
    const taggedReason = `[rung:${targetRung}] ${baseReason}`;
    try {
      await mcpEditAgent(agent.id, targetModel);
      healActions.push({
        agentId: agent.id, agentTitle: agent.title,
        from: getModelLabel(agent.model, config),
        to: getModelLabel(targetModel, config),
        reason: taggedReason,
      });
      state.switches.push({
        agentId: agent.id, agentTitle: agent.title,
        originalModel: agent.model, currentModel: targetModel,
        switchedAt: new Date().toISOString(),
        reason: taggedReason,
      });
      state.healCount++;
      log(`HEALED: ${agent.title} → ${getModelLabel(targetModel, config)} [rung:${targetRung}]`);
    } catch (err: any) {
      log(`Failed to switch ${agent.title}: ${err.message}`);
    }
  }

  // Step 4: Restore — check if original models recovered for previously switched agents
  const remaining: SwitchRecord[] = [];
  for (const sw of state.switches) {
    if (healActions.find((a) => a.agentId === sw.agentId)) { remaining.push(sw); continue; }

    const probe = state.lastProbe[sw.originalModel];
    if (probe?.healthy) {
      try {
        await mcpEditAgent(sw.agentId, sw.originalModel);
        restoreActions.push({
          agentId: sw.agentId, agentTitle: sw.agentTitle,
          from: getModelLabel(sw.currentModel, config),
          to: getModelLabel(sw.originalModel, config),
        });
        state.restoreCount++;
        log(`RESTORED: ${sw.agentTitle} → ${getModelLabel(sw.originalModel, config)}`);
      } catch (err: any) {
        log(`Failed to restore ${sw.agentTitle}: ${err.message}`);
        remaining.push(sw);
      }
    } else {
      remaining.push(sw);
    }
  }
  state.switches = remaining;
  saveState(state);

  // Step 5: Notify via email (only if actions taken or chain exhaustion)
  if (healActions.length > 0 || restoreActions.length > 0 || exhaustedAlerts.length > 0) {
    const switchRows = healActions.map((a) =>
      `<tr><td>${a.agentTitle}</td><td>${a.from}</td><td>→</td><td>${a.to}</td><td>${a.reason.slice(0, 80)}</td></tr>`
    ).join("\n");
    const restoreRows = restoreActions.map((a) =>
      `<tr><td>${a.agentTitle}</td><td>${a.from}</td><td>→</td><td>${a.to}</td><td>Model recovered</td></tr>`
    ).join("\n");
    const exhaustedRows = exhaustedAlerts.map((a) =>
      `<tr><td>${a.agentTitle}</td><td>${a.modelLabel}</td><td>${a.chainLabels.join(" → ") || "(no fallbacks)"}</td><td>${a.reason.slice(0, 80)}</td></tr>`
    ).join("\n");

    const parts: string[] = [];
    if (healActions.length > 0) parts.push(`${healActions.length} switch(es)`);
    if (restoreActions.length > 0) parts.push(`${restoreActions.length} restore(s)`);
    if (exhaustedAlerts.length > 0) parts.push(`${exhaustedAlerts.length} exhausted`);
    const subjectIcon = exhaustedAlerts.length > 0 ? "🚨" : "⚕️";
    const subject = `${subjectIcon} Model Healer — ${parts.join(", ")}`;
    const body = `
<h2>Zouroboros Model Healer Report</h2>
<p><strong>Time:</strong> ${new Date().toISOString()}</p>
<p><strong>Unhealthy models:</strong> ${unhealthy.map(([m, p]) => `${getModelLabel(m, config)} (${p.error?.slice(0, 60)})`).join(", ")}</p>
${healActions.length > 0 ? `
<h3>🔄 Switches</h3>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>Agent</th><th>From</th><th></th><th>To</th><th>Reason</th></tr>
${switchRows}
</table>` : ""}
${restoreActions.length > 0 ? `
<h3>✅ Restores</h3>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>Agent</th><th>From</th><th></th><th>To</th><th>Reason</th></tr>
${restoreRows}
</table>` : ""}
${exhaustedAlerts.length > 0 ? `
<h3>🚨 Chain Exhausted — Manual Intervention Required</h3>
<p>The following agents are wired to a model whose entire fallback chain is unhealthy. Per v6 policy, the healer does <strong>not</strong> cascade to <code>zo:smart</code>; you must intervene manually (top up credits, reconfigure the chain, or switch the agent yourself).</p>
<table border="1" cellpadding="4" cellspacing="0">
<tr><th>Agent</th><th>Unhealthy Model</th><th>Chain Tried</th><th>Reason</th></tr>
${exhaustedRows}
</table>` : ""}
<p><strong>Still on fallback:</strong> ${remaining.length} agent(s)</p>
<p><em>— Zouroboros Model Healer (cron, zero-cost orchestration)</em></p>
`.trim();

    await mcpSendEmail(subject, body);
  }

  // Step 6: Daily heartbeat — if you stop getting this, the healer (or Zo) is down
  await maybeSendHeartbeat(state, config);
  saveState(state);

  const summary = `${healActions.length} switch(es), ${restoreActions.length} restore(s), ${exhaustedAlerts.length} exhausted. ${remaining.length} still on fallback.`;
  log(`Run complete: ${summary}`);
  console.log(JSON.stringify({ phase: "complete", healActions, restoreActions, exhaustedAlerts, summary }));
}

// Legacy run command (outputs instructions, doesn't execute)
async function cmdRun(agentsJson?: string) {
  log("=== Healer Run (legacy mode) ===");
  log("TIP: Use 'auto' command for fully autonomous cron mode.");
  const config = loadConfig();
  const state = loadState();
  const uniqueModels = new Set<string>(Object.keys(config.fallbackChains));
  for (const sw of state.switches) uniqueModels.add(sw.originalModel);

  for (const model of uniqueModels) {
    const result = await probeModel(model, config);
    state.lastProbe[model] = result;
    const icon = result.health === "healthy" ? "✅" : result.health === "degraded" ? "⚠️" : "❌";
    const detail = result.error || result.warning || "";
    log(`  ${icon} ${getModelLabel(model, config)} (${result.latencyMs}ms)${detail ? ` — ${detail}` : ""}`);
  }
  state.lastRunAt = new Date().toISOString();
  saveState(state);

  const unhealthy = Object.entries(state.lastProbe).filter(([, p]) => !p.healthy);
  if (unhealthy.length === 0 && state.switches.length === 0) {
    console.log(JSON.stringify({ command: "run", summary: "All models healthy. Nothing to do." }));
    return;
  }
  console.log(JSON.stringify({
    command: "run", phase: "needs_agents",
    unhealthyModels: unhealthy.map(([m, p]) => ({ model: m, label: getModelLabel(m, config), error: p.error })),
    activeSwitches: state.switches.length,
    instruction: "Use 'auto' command instead, or call list_agents + heal/restore manually.",
  }, null, 2));
}

// ── CLI ─────────────────────────────────────────────────────────────
// Skip CLI dispatch when imported (e.g. by tests) — only run when invoked directly.
const isMain = import.meta.path === Bun.main;
const [cmd, ...args] = isMain ? process.argv.slice(2) : [];

if (isMain) switch (cmd) {
  case "probe": await cmdProbe(); break;
  case "diagnose": await cmdDiagnose(); break;
  case "status": await cmdStatus(); break;
  case "auto": await cmdAuto(); break;
  case "run": await cmdRun(args[0]); break;
  case "validate": {
    const cfg = loadConfig();
    const r = validateChain(cfg);
    console.log(JSON.stringify({ command: "validate", ...r }, null, 2));
    process.exit(r.ok ? 0 : 2);
  }
  default:
    console.log(`Zouroboros Agent Model Healer v2

Commands:
  auto               Full autonomous pipeline (for cron — zero AI model cost)
  probe              Test all configured models, output health status
  diagnose           Show unhealthy models and active switches
  status             Show full healer state
  validate           Check fallback-chain.json invariants (terminal, dangling, proprietary→open-weight)
  run                Legacy: probe + output instructions

Cron mode (auto):
  1. Probes all models via /zo/ask (minimal tokens)
  2. Lists agents via direct MCP (zero cost)
  3. Switches unhealthy agents via direct MCP edit_agent (zero cost)
  4. Restores agents when original models recover
  5. Sends email notification only when actions taken

State: ${STATE_PATH}
Config: ${CONFIG_PATH}
Logs: ${LOG_PATH}`);
}
