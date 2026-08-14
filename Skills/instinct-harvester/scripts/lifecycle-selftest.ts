// ZOU-556 instinct-harvester lifecycle selftest — deterministic, no LLM, no I/O.
//   bun lifecycle-selftest.ts   (exit 0 = all pass)
//
// Pure-logic only: planLifecycle et al. never touch the live store, so unlike
// the main selftest there is no temp-path / ESM-hoisting hazard here.

import type { Instinct } from "./merge";
import {
  ageInDays,
  liveness,
  isProtected,
  keepScore,
  planLifecycle,
  renderReport,
  safeNum,
  DEFAULT_LIFECYCLE,
  type LifecycleConfig,
  type LifecycleInstinct,
} from "./lifecycle";

let pass = 0;
let fail = 0;
function ck(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const TODAY = "2026-07-10";
const cfg = (over: Partial<LifecycleConfig> = {}): LifecycleConfig => ({
  today: TODAY,
  ...DEFAULT_LIFECYCLE,
  ...over,
});

const base = (over: Partial<LifecycleInstinct> = {}): LifecycleInstinct => ({
  id: "inst_001",
  trigger: "when X",
  action: "do Z",
  domain: "evaluation",
  confidence: 0.7,
  source: "session-observation",
  reinforced_count: 1,
  last_seen: TODAY,
  ...over,
});

// --- ageInDays ---
ck("age same day", ageInDays(TODAY, TODAY), 0);
ck("age 30d", ageInDays("2026-06-10", TODAY), 30);
ck("age future clamps to 0", ageInDays("2026-08-01", TODAY), 0);
ck("age invalid → 0", ageInDays("not-a-date", TODAY), 0);

// --- safeNum (CLI boundary numeric guard against fat-finger data loss) ---
ck("safeNum passes finite string", safeNum("30", 99), 30);
ck("safeNum passes number", safeNum(30, 99), 30);
ck("safeNum NaN → fallback", safeNum("abc", 99), 99);
ck("safeNum undefined → fallback", safeNum(undefined, 99), 99);
ck("safeNum empty string → fallback", safeNum("", 200, 1), 200);
ck("safeNum below min → fallback", safeNum("-1", 200, 1), 200);
ck("safeNum zero cap below min1 → fallback", safeNum("0", 200, 1), 200);
ck("safeNum in range passes", safeNum("0.5", 0.5, 0, 1), 0.5);
ck("safeNum above max → fallback (supersede >1 can't invert)", safeNum("1.5", 0.5, 0, 1), 0.5);

// --- liveness (half-life curve) ---
ck("liveness age0 = 1", liveness(base({ last_seen: TODAY }), TODAY, 30), 1);
ck("liveness one half-life = 0.5", liveness(base({ last_seen: "2026-06-10" }), TODAY, 30), 0.5);
ck("liveness two half-lives = 0.25", liveness(base({ last_seen: "2026-05-11" }), TODAY, 30), 0.25);
ck("liveness never touches confidence", base({ confidence: 0.7 }).confidence, 0.7);

// --- isProtected ---
ck("protected by high conf", isProtected(base({ confidence: 0.95 }), cfg()), true);
ck("protected by critical flag", isProtected(base({ confidence: 0.3, critical: true }), cfg()), true);
ck("protected by reinforced count", isProtected(base({ confidence: 0.5, reinforced_count: 8 }), cfg()), true);
ck("not protected (weak/quiet)", isProtected(base({ confidence: 0.6, reinforced_count: 2 }), cfg()), false);

// --- keepScore ---
ck(
  "keepScore unprotected = blended",
  keepScore(base({ confidence: 0.6, last_seen: "2026-06-10" }), cfg()),
  0.3, // 0.6 * 0.5
);
ck(
  "keepScore protected floored at confidence",
  keepScore(base({ confidence: 0.95, last_seen: "2026-05-11" }), cfg()) >= 0.95,
  true,
);

// --- planLifecycle: clean store, under cap, no markers ---
const clean = [
  base({ id: "inst_001", confidence: 0.8 }),
  base({ id: "inst_002", confidence: 0.6, domain: "infra" }),
];
const p1 = planLifecycle(clean, cfg());
ck("clean: nothing superseded", p1.supersessions.length, 0);
ck("clean: nothing pruned", p1.pruned.length, 0);
ck("clean: all kept", p1.kept.length, 2);
ck("clean: input not mutated", clean[0].confidence, 0.8);

// --- planLifecycle: supersession demotes target, stamps pointer ---
const withMarker = [
  base({ id: "inst_010", confidence: 0.8, action: "old wrong action" }),
  base({ id: "inst_011", confidence: 0.85, action: "new correct action", supersedes: "inst_010" }),
];
const p2 = planLifecycle(withMarker, cfg());
ck("supersede recorded", p2.supersessions.map((s) => [s.superseded, s.from, s.to]), [["inst_010", 0.8, 0.4]]);
const demoted = p2.kept.find((i) => i.id === "inst_010");
ck("supersede: target demoted", demoted?.confidence, 0.4);
ck("supersede: target stamped", demoted?.superseded_by, "inst_011");
ck("supersede: input untouched", withMarker[0].confidence, 0.8);

// --- planLifecycle: supersession is idempotent ---
const p2b = planLifecycle(p2.kept, cfg());
ck("supersede idempotent (no re-demote)", p2b.supersessions.length, 0);
ck("supersede idempotent: confidence stable", p2b.kept.find((i) => i.id === "inst_010")?.confidence, 0.4);

// --- planLifecycle: a 2nd, different superseder can't re-demote or clobber the pointer ---
const doubleSup = [
  base({ id: "inst_030", confidence: 0.8 }),
  base({ id: "inst_031", confidence: 0.85, supersedes: "inst_030" }),
  base({ id: "inst_032", confidence: 0.88, supersedes: "inst_030" }),
];
const p5 = planLifecycle(doubleSup, cfg());
ck("double-supersede: demoted once only", p5.supersessions.length, 1);
const t030 = p5.kept.find((i) => i.id === "inst_030");
ck("double-supersede: first superseder wins pointer", t030?.superseded_by, "inst_031");
ck("double-supersede: confidence demoted once (0.8→0.4)", t030?.confidence, 0.4);

// --- planLifecycle: dangling supersedes marker is a safe no-op ---
const dangling = [base({ id: "inst_020", supersedes: "inst_999" })];
ck("dangling supersedes → no-op", planLifecycle(dangling, cfg()).supersessions.length, 0);

// --- planLifecycle: prune over cap keeps highest keep-score, protects strong ---
const many: LifecycleInstinct[] = [
  // one strong-but-ancient instinct that MUST survive on protection
  base({ id: "inst_100", confidence: 0.95, last_seen: "2026-01-01" }),
  ...Array.from({ length: 5 }, (_, i) =>
    base({ id: `inst_2${i}`, confidence: 0.5 + i * 0.02, last_seen: TODAY, domain: "infra" }),
  ),
];
const p3 = planLifecycle(many, cfg({ cap: 3 }));
ck("prune: kept capped (protected may exceed)", p3.kept.length >= 3, true);
ck("prune: ancient-but-strong survived", p3.kept.some((i) => i.id === "inst_100"), true);
ck("prune: something evicted over cap", p3.pruned.length, 3);
const prunedIds = new Set(p3.pruned.map((p) => p.id));
ck("prune: protected never pruned", prunedIds.has("inst_100"), false);

// --- decayWatch: sorted by liveness asc, excludes protected ---
const mix = [
  base({ id: "inst_a", confidence: 0.6, last_seen: "2026-04-11" }), // oldest, low liveness
  base({ id: "inst_b", confidence: 0.6, last_seen: TODAY }), // fresh
  base({ id: "inst_c", confidence: 0.95, last_seen: "2026-01-01" }), // protected → excluded
];
const p4 = planLifecycle(mix, cfg());
ck("decayWatch excludes protected", p4.decayWatch.some((d) => d.id === "inst_c"), false);
ck("decayWatch: lowest liveness first", p4.decayWatch[0]?.id, "inst_a");

// --- renderReport ---
const rep = renderReport(p1, cfg(), false);
ck("report shows advisory mode", rep.includes("ADVISORY"), true);
ck("report shows summary", rep.includes("2 instincts"), true);
ck("report notes no-op cycle", rep.includes("No mutations this cycle"), true);
ck("report applied mode label", renderReport(p2, cfg(), true).includes("APPLIED"), true);

console.log(`instinct-harvester lifecycle selftest: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
