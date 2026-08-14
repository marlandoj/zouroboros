#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";

const REP_PATH = `${process.env.HOME}/.zouroboros/reputation.json`;
const QUARANTINE_PATH = `${process.env.HOME}/.zouroboros/quarantine-state.json`;

interface QuarantineState {
  quarantined: Array<{
    model: string;
    since: string;
    reason: string;
    effective_weight: number;
    shadow_runs: number;
    shadow_passes: number;
  }>;
  shadowLog: Array<{
    model: string;
    date: string;
    effective_weight: number;
  }>;
}

function loadReputation() {
  return JSON.parse(fs.readFileSync(REP_PATH, "utf-8"));
}

function loadQuarantine(): QuarantineState {
  if (!fs.existsSync(QUARANTINE_PATH)) {
    return { quarantined: [], shadowLog: [] };
  }
  return JSON.parse(fs.readFileSync(QUARANTINE_PATH, "utf-8"));
}

function saveQuarantine(state: QuarantineState) {
  fs.mkdirSync(`${process.env.HOME}/.zouroboros`, { recursive: true });
  fs.writeFileSync(QUARANTINE_PATH, JSON.stringify(state, null, 2));
}

function checkThresholds(): { candidates: Array<{ model: string; effective_weight: number; total_votes: number }>; active: number } {
  const rep = loadReputation();
  const candidates: Array<{ model: string; effective_weight: number; total_votes: number }> = [];

  for (const [model, stats] of Object.entries(rep.voters) as [string, any][]) {
    if (model.startsWith("non-llm/")) continue;
    if (stats.total_votes < 50) continue;
    if ((stats.status ?? "active") === "quarantine") {
      candidates.push({ model, effective_weight: stats.effective_weight, total_votes: stats.total_votes });
      continue;
    }
    if (stats.effective_weight < 0.50) {
      candidates.push({ model, effective_weight: stats.effective_weight, total_votes: stats.total_votes });
    }
  }

  const active = Object.values(rep.voters).filter(
    (v: any) => (v.status ?? "active") !== "quarantine" && !v.model?.startsWith("non-llm/")
  ).length;

  return { candidates, active };
}

function applyHotSwap(model: string): string | null {
  const { getChain } = require("./catalog");
  try {
    const chain = getChain(model);
    if (chain && chain.length > 0) {
      return chain[0];
    }
  } catch {}
  return null;
}

function quarantineCheck(): void {
  const { candidates, active } = checkThresholds();

  if (candidates.length === 0) {
    console.log("✅ No voters below quarantine threshold");
    return;
  }

  const state = loadQuarantine();

  for (const c of candidates) {
    const alreadyQuarantined = state.quarantined.find(q => q.model === c.model);
    if (alreadyQuarantined) continue;

    // Cascade cap
    if (state.quarantined.length >= 1) {
      console.log(`\n⚠️  CASCADE PREVENTION: ${c.model} also qualifies (eff=${c.effective_weight.toFixed(3)})`);
      console.log(`   One quarantine already active. Paging user for manual review.\n`);

      // Output full table for manual decision
      weeklyDigest();
      process.exit(2);
    }

    // Quarantine this voter
    const replacement = applyHotSwap(c.model);
    state.quarantined.push({
      model: c.model,
      since: new Date().toISOString(),
      reason: `effective_weight=${c.effective_weight.toFixed(3)} (< 0.50) over ${c.total_votes} runs`,
      effective_weight: c.effective_weight,
      shadow_runs: 0,
      shadow_passes: 0,
    });

    // Mark in reputation
    const rep = loadReputation();
    if (rep.voters[c.model]) {
      rep.voters[c.model].status = "quarantine";
      rep.voters[c.model].quarantined_since = new Date().toISOString();
      fs.writeFileSync(REP_PATH, JSON.stringify(rep, null, 2));
    }

    console.log(`\n🚫 QUARANTINED: ${c.model}`);
    console.log(`   Reason: effective_weight=${c.effective_weight.toFixed(3)} (< 0.50)`);
    console.log(`   Replacement: ${replacement ?? "none available — manual intervention required"}`);
  }

  saveQuarantine(state);
}

function weeklyDigest(): void {
  const rep = loadReputation();
  const state = loadQuarantine();

  console.log(`\n📊 Weekly Consensus Gate Health Digest — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`   Runs: ${rep.runs}`);
  console.log();

  const modelMaxLen = Math.max(...Object.keys(rep.voters).map(m => m.length), 45);
  console.log(
    `${"Voter".padEnd(modelMaxLen)}  eff_wt   Status    30d  Votes`
  );
  console.log(`${"-".repeat(modelMaxLen)}  ------   --------  ---  -----`);

  for (const [model, stats] of Object.entries(rep.voters).sort(
    (a, b) => (b[1] as any).effective_weight - (a[1] as any).effective_weight
  )) {
    const s = stats as any;
    const status = s.status ?? (model.startsWith("non-llm/") ? "arbiter" : "active");
    const qEntry = state.quarantined.find(q => q.model === model);
    const suffix = qEntry
      ? ` (${qEntry.shadow_runs}/10 shadow, ${Math.floor((Date.now() - new Date(qEntry.since).getTime()) / 86400000)}d)`
      : "";
    console.log(
      `${model.padEnd(modelMaxLen)}  ${s.effective_weight.toFixed(4)}   ${(status + suffix).padEnd(9)}  ${Math.floor(s.effective_weight * 100)}%  ${s.total_votes}`
    );
  }
}

function scheduleWeeklyShadow(): void {
  const state = loadQuarantine();
  const rep = loadReputation();

  for (const q of state.quarantined) {
    const daysElapsed = (Date.now() - new Date(q.since).getTime()) / 86400000;
    const voter = rep.voters[q.model];

    if (!voter) continue;

    // Update shadow log with latest effective_weight
    state.shadowLog.push({
      model: q.model,
      date: new Date().toISOString(),
      effective_weight: voter.effective_weight,
    });

    // Trim shadow log to last 10 entries
    const modelLog = state.shadowLog.filter(l => l.model === q.model).slice(-10);
    state.shadowLog = state.shadowLog.filter(l => l.model !== q.model).concat(modelLog);

    // Check recovery conditions
    const recoveryLog = modelLog.filter(l => l.effective_weight > 0.65);
    const recoveryRuns = recoveryLog.length;

    q.shadow_runs = modelLog.length;
    q.shadow_passes = recoveryRuns;

    if (recoveryRuns >= 10 && daysElapsed >= 14) {
      console.log(`\n✅ RECOVERED: ${q.model}`);
      console.log(`   effective_weight: ${voter.effective_weight.toFixed(3)} (> 0.65)`);
      console.log(`   Shadow runs: ${recoveryRuns}/10 passed`);
      console.log(`   Days elapsed: ${daysElapsed.toFixed(1)}/14`);

      // Restore to active
      voter.status = "active";
      delete voter.quarantined_since;
      state.quarantined = state.quarantined.filter(x => x.model !== q.model);
    } else if (modelLog.length > 0) {
      console.log(`⏳ ${q.model}: ${recoveryRuns}/10 shadow passes, ${daysElapsed.toFixed(1)}/14 days`);
    }
  }

  saveQuarantine(state);
  if (rep) {
    fs.writeFileSync(REP_PATH, JSON.stringify(rep, null, 2));
  }
}

export function getActiveModels(): string[] {
  const rep = loadReputation();
  const state = loadQuarantine();
  const quarantinedModels = new Set(state.quarantined.map(q => q.model));

  // Default trio minus quarantined.
  // 2026-07-01: GLM-5.1 and Kimi-K2.6 were delisted from synthetic.new (hard 404
  // on the primary vendor every run) — replaced with their current successors,
  // both verified live on synthetic.new AND OpenRouter for same-model failover.
  const defaults = ["hf:zai-org/GLM-5.2", "hf:moonshotai/Kimi-K2.7-Code", "xai:grok-3-mini"];
  const active: string[] = [];

  for (const model of defaults) {
    if (quarantinedModels.has(model)) {
      const replacement = applyHotSwap(model);
      if (replacement) {
        active.push(replacement);
      }
    } else {
      active.push(model);
    }
  }

  return active;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean" as const, default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`Quarantine Manager for Consensus Gate

Usage:
  bun run quarantine.ts check       Check for voters below threshold
  bun run quarantine.ts hotswap     Apply quarantine + hot-swap
  bun run quarantine.ts shadow      Run weekly shadow check for recovering voters
  bun run quarantine.ts digest      Weekly health digest (text table)`);
    process.exit(0);
  }

  const cmd = positionals[0];

  switch (cmd) {
    case "check":
      quarantineCheck();
      break;
    case "hotswap":
      quarantineCheck();
      break;
    case "shadow":
      scheduleWeeklyShadow();
      break;
    case "digest":
      weeklyDigest();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
