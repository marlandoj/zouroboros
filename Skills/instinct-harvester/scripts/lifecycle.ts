// ZOU-556 instinct-harvester — Phase 1 confidence lifecycle (pure logic + CLI).
//
// The store's write path (merge.ts) only ever ratchets confidence UP
// (Math.max on reinforce). Nothing ages, nothing is ever demoted, and prune is
// manual. This module adds the daily maintenance half:
//
//   liveness   — a recency signal derived from last_seen, SEPARATE from
//                confidence (quality). Never mutates confidence.
//   protection — strong / critical instincts are shielded from eviction, so a
//                long-quiet-but-high-confidence instinct always survives.
//   supersession — the ONLY downward confidence path: an instinct carrying a
//                `supersedes: <id>` marker demotes the instinct it replaces and
//                stamps `superseded_by` for audit. Deterministic; dormant until
//                a producer writes the marker (semantic contradiction detection
//                is Phase 2).
//   prune      — cap the store by a blended keep-score (confidence · liveness),
//                protected instincts always kept.
//
// Advisory-first: the CLI computes + reports by default and writes NOTHING.
// Mutation requires --apply (or INSTINCT_LIFECYCLE_ENFORCE=1). Byte-identical
// store when not applied.

import type { Instinct } from "./merge";

// Optional, backward-compatible lifecycle markers. Absent on legacy rows; the
// YAML round-trip preserves any present. All optional so the base Instinct
// contract (and every existing writer) is untouched.
export interface LifecycleInstinct extends Instinct {
  critical?: boolean; // hard-protect from decay/prune regardless of confidence
  supersedes?: string; // id of an instinct this one replaces (demotes the target)
  superseded_by?: string; // stamped onto a demoted instinct (audit pointer)
}

export interface LifecycleConfig {
  today: string; // YYYY-MM-DD
  halfLifeDays: number; // liveness half-life (default 30)
  protectConfidence: number; // protect if confidence >= this (default 0.90)
  protectReinforced: number; // protect if reinforced_count >= this (default 8)
  cap: number; // prune target (default 200)
  supersedeFactor: number; // multiply a superseded instinct's confidence (default 0.5)
}

export const DEFAULT_LIFECYCLE: Omit<LifecycleConfig, "today"> = {
  halfLifeDays: 30,
  protectConfidence: 0.9,
  protectReinforced: 8,
  cap: 200,
  supersedeFactor: 0.5,
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

// Parse a numeric CLI/env value at the system boundary. Falls back to the
// default on anything non-finite, empty, or out of [min, max] (`--cap abc`,
// `INSTINCT_CAP=`, a negative cap, or a supersede factor > 1 that would INVERT
// the only-downward-confidence invariant). Guards the mutating path against
// fat-finger data loss.
export function safeNum(
  raw: string | number | undefined,
  fallback: number,
  min?: number,
  max?: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

export function ageInDays(lastSeen: string, today: string): number {
  const a = Date.parse(`${lastSeen}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// Recency signal in (0, 1]. Exponential half-life: 1.0 at age 0, 0.5 at one
// half-life, etc. Fresh/frequently-reinforced instincts (last_seen bumped) stay
// near 1.0. Confidence is never touched.
export function liveness(inst: Instinct, today: string, halfLifeDays: number): number {
  const age = ageInDays(inst.last_seen, today);
  return Math.pow(0.5, age / Math.max(1, halfLifeDays));
}

export function isProtected(inst: LifecycleInstinct, cfg: LifecycleConfig): boolean {
  return (
    inst.critical === true ||
    inst.confidence >= cfg.protectConfidence ||
    inst.reinforced_count >= cfg.protectReinforced
  );
}

// Blended keep-score used for prune ranking. Protected instincts get a floor of
// their raw confidence so a strong-but-quiet instinct never sorts below fresh
// noise and gets evicted.
export function keepScore(inst: LifecycleInstinct, cfg: LifecycleConfig): number {
  const blended = inst.confidence * liveness(inst, cfg.today, cfg.halfLifeDays);
  return isProtected(inst, cfg) ? Math.max(blended, inst.confidence) : blended;
}

export interface SupersedeAction {
  superseder: string;
  superseded: string;
  from: number;
  to: number;
}

export interface DecayRow {
  id: string;
  domain: string;
  age: number;
  liveness: number;
  blended: number;
}

export interface LifecyclePlan {
  total: number;
  protectedIds: string[];
  supersessions: SupersedeAction[];
  pruned: { id: string; domain: string; score: number }[];
  kept: LifecycleInstinct[];
  decayWatch: DecayRow[]; // lowest-liveness non-protected instincts
}

// Pure: produces the maintenance plan + the resulting kept set. Input is not
// mutated (works on shallow clones).
export function planLifecycle(
  instincts: LifecycleInstinct[],
  cfg: LifecycleConfig,
): LifecyclePlan {
  const working: LifecycleInstinct[] = instincts.map((i) => ({ ...i }));
  const byId = new Map(working.map((i) => [i.id, i]));

  // 1. Supersession — the only downward confidence path. A target is superseded
  //    at most once (first marker in store order wins): if it already carries a
  //    superseded_by stamp we leave it alone. This keeps re-runs idempotent and
  //    stops a second, different superseder from compounding the demotion or
  //    clobbering the original audit pointer.
  const supersessions: SupersedeAction[] = [];
  for (const i of working) {
    if (!i.supersedes || i.supersedes === i.id) continue;
    const target = byId.get(i.supersedes);
    if (!target || target.superseded_by) continue;
    const from = target.confidence;
    const to = Math.max(0.01, round2(from * cfg.supersedeFactor));
    target.confidence = to;
    target.superseded_by = i.id;
    supersessions.push({ superseder: i.id, superseded: target.id, from, to });
  }

  // 2. Protection set (recomputed after demotion so a just-demoted instinct can
  //    fall out of protection).
  const protectedSet = new Set(working.filter((i) => isProtected(i, cfg)).map((i) => i.id));

  // 3. Prune by keep-score; protected instincts are always kept even past cap.
  const ranked = [...working].sort(
    (a, b) => keepScore(b, cfg) - keepScore(a, cfg) || a.id.localeCompare(b.id),
  );
  const kept: LifecycleInstinct[] = [];
  const pruned: { id: string; domain: string; score: number }[] = [];
  for (const i of ranked) {
    if (kept.length < cfg.cap || protectedSet.has(i.id)) kept.push(i);
    else pruned.push({ id: i.id, domain: i.domain, score: round2(keepScore(i, cfg)) });
  }

  const decayWatch: DecayRow[] = working
    .filter((i) => !protectedSet.has(i.id))
    .map((i) => {
      const live = liveness(i, cfg.today, cfg.halfLifeDays);
      return {
        id: i.id,
        domain: i.domain,
        age: ageInDays(i.last_seen, cfg.today),
        liveness: round2(live),
        blended: round2(i.confidence * live),
      };
    })
    .sort((a, b) => a.liveness - b.liveness || a.blended - b.blended)
    .slice(0, 10);

  return {
    total: instincts.length,
    protectedIds: [...protectedSet].sort(),
    supersessions,
    pruned,
    kept,
    decayWatch,
  };
}

export function renderReport(plan: LifecyclePlan, cfg: LifecycleConfig, applied: boolean): string {
  const mode = applied ? "APPLIED" : "ADVISORY (dry-run — no writes)";
  const L: string[] = [];
  L.push(`# Instinct Lifecycle — ${cfg.today}`);
  L.push("");
  L.push(`**Mode:** ${mode}`);
  L.push(
    `**Config:** half-life ${cfg.halfLifeDays}d · protect conf ≥ ${cfg.protectConfidence} ` +
      `or reinforced ≥ ${cfg.protectReinforced} · cap ${cfg.cap} · supersede ×${cfg.supersedeFactor}`,
  );
  L.push("");
  L.push(
    `**Summary:** ${plan.total} instincts · ${plan.protectedIds.length} protected · ` +
      `${plan.supersessions.length} superseded · ${plan.pruned.length} pruned · ` +
      `${plan.kept.length} kept`,
  );
  L.push("");

  if (plan.supersessions.length > 0) {
    L.push("## Supersessions (confidence demoted)");
    for (const s of plan.supersessions)
      L.push(`- ${s.superseded}: ${s.from} → ${s.to} (superseded by ${s.superseder})`);
    L.push("");
  }

  if (plan.pruned.length > 0) {
    L.push("## Pruned (over cap, lowest keep-score)");
    for (const p of plan.pruned) L.push(`- ${p.id} [${p.domain}] keep-score ${p.score}`);
    L.push("");
  }

  L.push("## Decay watch (lowest liveness, unprotected)");
  if (plan.decayWatch.length === 0) {
    L.push("- (none)");
  } else {
    for (const d of plan.decayWatch)
      L.push(`- ${d.id} [${d.domain}] age ${d.age}d · liveness ${d.liveness} · blended ${d.blended}`);
  }
  L.push("");

  if (plan.supersessions.length === 0 && plan.pruned.length === 0) {
    L.push(
      "_No mutations this cycle: nothing over cap and no supersession markers. " +
        "Liveness/prune activate as the corpus ages and grows — the mechanism is in place._",
    );
    L.push("");
  }
  return L.join("\n");
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const { loadStore, saveStore } = await import("./observer");
  const args = process.argv.slice(2);

  const cfg: LifecycleConfig = {
    today: argVal(args, "--today") ?? new Date().toISOString().slice(0, 10),
    halfLifeDays: safeNum(argVal(args, "--half-life"), DEFAULT_LIFECYCLE.halfLifeDays, 1),
    protectConfidence: safeNum(
      argVal(args, "--protect-conf"),
      DEFAULT_LIFECYCLE.protectConfidence,
      0,
    ),
    protectReinforced: safeNum(
      argVal(args, "--protect-reinforced"),
      DEFAULT_LIFECYCLE.protectReinforced,
      0,
    ),
    cap: safeNum(argVal(args, "--cap") ?? process.env.INSTINCT_CAP, DEFAULT_LIFECYCLE.cap, 1),
    supersedeFactor: safeNum(
      argVal(args, "--supersede-factor"),
      DEFAULT_LIFECYCLE.supersedeFactor,
      0,
      1,
    ),
  };

  const apply = args.includes("--apply") || process.env.INSTINCT_LIFECYCLE_ENFORCE === "1";
  const store = loadStore();
  const plan = planLifecycle(store.instincts as LifecycleInstinct[], cfg);
  const report = renderReport(plan, cfg, apply);

  const reportPath = argVal(args, "--report");
  if (reportPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(reportPath, `${report}\n`);
  }
  console.log(report);

  if (apply) {
    // Only write when the plan actually changes something — keeps the store
    // byte-identical on no-op cycles.
    if (plan.supersessions.length > 0 || plan.pruned.length > 0) {
      saveStore({ instincts: plan.kept });
      console.log(
        `\n[lifecycle] APPLIED: ${plan.supersessions.length} superseded, ${plan.pruned.length} pruned; ${plan.kept.length} kept`,
      );
    } else {
      console.log("\n[lifecycle] APPLIED: no-op (nothing to change) — store untouched");
    }
  } else {
    console.log("\n[lifecycle] advisory only — pass --apply to mutate");
  }
}
