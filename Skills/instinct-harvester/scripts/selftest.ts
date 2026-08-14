// ZOU-451 instinct-harvester selftest — deterministic, no LLM, isolated store.
//   bun selftest.ts     (exit 0 = all pass)

// NOTE: never mutate the live store from here. ESM imports are hoisted, so a
// top-of-file process.env.INSTINCT_STORE_PATH assignment does NOT reach
// observer.ts's module init — pass explicit paths instead. (This exact
// hoisting bug once made the selftest delete the production store.)
import { rmSync } from "node:fs";
import { mergeCandidate, normalizeKey, validateCandidate, nextId, type Instinct } from "./merge";
import { pruneInstincts, rankInstincts } from "./prune";
import { loadStore, saveStore, selectForBriefing, renderBriefing } from "./observer";

const TMP = `/tmp/instincts-selftest-${process.pid}.yaml`;

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

const D = "2026-07-03";
const base = (over: Partial<Instinct> = {}): Instinct => ({
  id: "inst_001",
  trigger: "when X",
  action: "do Z",
  domain: "evaluation",
  confidence: 0.8,
  source: "repo-curated",
  reinforced_count: 2,
  last_seen: "2026-07-01",
  ...over,
});

// --- validation ---
ck("valid candidate", validateCandidate({ trigger: "t", action: "a", domain: "eval-x" }), []);
ck("missing trigger", validateCandidate({ action: "a", domain: "d" }).length > 0, true);
ck("bad domain slug", validateCandidate({ trigger: "t", action: "a", domain: "Not A Slug" }).length, 1);
ck("bad confidence", validateCandidate({ trigger: "t", action: "a", domain: "d", confidence: 1.5 }).length, 1);

// --- key normalization ---
ck("key normalizes case/ws", normalizeKey("  When   X ", "EVAL"), normalizeKey("when x", "eval"));

// --- merge: add new ---
const m1 = mergeCandidate([], { trigger: "when X", action: "do Z", domain: "evaluation" }, D);
ck("add outcome", m1.outcome.kind, "added");
ck("add id", m1.instincts[0]?.id, "inst_001");
ck("add defaults", [m1.instincts[0]?.confidence, m1.instincts[0]?.reinforced_count], [0.7, 1]);

// --- merge: reinforcement, existing higher confidence wins fields ---
const m2 = mergeCandidate(
  [base({ confidence: 0.9, action: "existing action" })],
  { trigger: "WHEN   x", action: "weaker action", domain: "evaluation", confidence: 0.5 },
  D,
);
ck("reinforce outcome", m2.outcome.kind, "reinforced");
ck("higher-conf fields win", m2.instincts[0]?.action, "existing action");
ck("conf keeps max", m2.instincts[0]?.confidence, 0.9);
ck("reinforced_count merged", m2.instincts[0]?.reinforced_count, 3);
ck("last_seen bumped", m2.instincts[0]?.last_seen, D);

// --- merge: candidate higher confidence wins fields, id stable ---
const m3 = mergeCandidate(
  [base({ confidence: 0.6, action: "old action" })],
  { trigger: "when X", action: "new better action", domain: "evaluation", confidence: 0.85 },
  D,
);
ck("candidate wins fields", m3.instincts[0]?.action, "new better action");
ck("id stable on win", m3.instincts[0]?.id, "inst_001");

// --- merge: equal confidence keeps existing fields, merges count ---
const m4 = mergeCandidate(
  [base({ confidence: 0.7, action: "existing" })],
  { trigger: "when X", action: "incoming", domain: "evaluation", confidence: 0.7 },
  D,
);
ck("equal conf keeps existing", m4.instincts[0]?.action, "existing");
ck("equal conf merges count", m4.instincts[0]?.reinforced_count, 3);

// --- nextId ---
ck("nextId gaps", nextId([base({ id: "inst_007" }), base({ id: "inst_002" })]), "inst_008");

// --- prune ---
const many = Array.from({ length: 205 }, (_, i) =>
  base({ id: `inst_${String(i + 1).padStart(3, "0")}`, trigger: `t${i}`, confidence: (i % 100) / 100 + 0.001 }),
);
const pr = pruneInstincts(many, 200);
ck("prune counts", [pr.kept.length, pr.pruned.length], [200, 5]);
const minKept = Math.min(...pr.kept.map((i) => i.confidence));
const maxPruned = Math.max(...pr.pruned.map((i) => i.confidence));
ck("prune keeps highest confidence", minKept >= maxPruned, true);
ck("no prune under cap", pruneInstincts(many.slice(0, 10), 200).pruned.length, 0);

// --- ranking tie-breaks ---
const ranked = rankInstincts([
  base({ id: "inst_002", confidence: 0.8, reinforced_count: 1 }),
  base({ id: "inst_003", confidence: 0.8, reinforced_count: 9 }),
  base({ id: "inst_004", confidence: 0.95 }),
]);
ck("rank by conf then count", ranked.map((i) => i.id), ["inst_004", "inst_003", "inst_002"]);

// --- store round-trip (isolated path) ---
saveStore({ instincts: [base(), base({ id: "inst_002", trigger: "when Y", domain: "infra" })] }, TMP);
const rt = loadStore(TMP);
ck("yaml round-trip count", rt.instincts.length, 2);
ck("yaml round-trip fields", rt.instincts[0], base());
ck("missing store reads empty", loadStore("/tmp/nonexistent-instincts.yaml").instincts, []);

// --- briefing selection ---
const pool = [
  base({ id: "inst_001", domain: "evaluation", confidence: 0.95, trigger: "eval trig", action: "eval act" }),
  base({ id: "inst_002", domain: "software-factory", confidence: 0.6, trigger: "sf trig", action: "sf act" }),
  base({ id: "inst_003", domain: "infra", confidence: 0.9 }),
];
ck("brief top-2 by confidence", selectForBriefing(pool, 2).map((i) => i.id), ["inst_001", "inst_003"]);
ck(
  "brief domain context boost",
  selectForBriefing(pool, 2, "working a software-factory ticket").map((i) => i.id)[0],
  "inst_002",
);
ck("brief renders trigger→action", renderBriefing([pool[0]]).includes("eval trig → eval act"), true);
ck("brief empty renders empty", renderBriefing([]), "");

rmSync(TMP, { force: true });
console.log(`instinct-harvester selftest: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
