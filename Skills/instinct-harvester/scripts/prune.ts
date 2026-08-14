// ZOU-451 instinct-harvester — confidence-ranked pruning (cap 200).
// Pure logic + a small CLI to apply the cap to the live store:
//   bun prune.ts [--cap 200] [--dry-run]

import type { Instinct } from "./merge";

export const INSTINCT_CAP = 200;

export function rankInstincts(instincts: Instinct[]): Instinct[] {
  return [...instincts].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.reinforced_count - a.reinforced_count ||
      b.last_seen.localeCompare(a.last_seen) ||
      a.id.localeCompare(b.id),
  );
}

export function pruneInstincts(
  instincts: Instinct[],
  cap: number = INSTINCT_CAP,
): { kept: Instinct[]; pruned: Instinct[] } {
  if (instincts.length <= cap) return { kept: instincts, pruned: [] };
  const ranked = rankInstincts(instincts);
  return { kept: ranked.slice(0, cap), pruned: ranked.slice(cap) };
}

if (import.meta.main) {
  const { loadStore, saveStore } = await import("./observer");
  const args = process.argv.slice(2);
  const capIdx = args.indexOf("--cap");
  const cap = capIdx !== -1 ? Number(args[capIdx + 1]) : INSTINCT_CAP;
  const dryRun = args.includes("--dry-run");
  const store = loadStore();
  const { kept, pruned } = pruneInstincts(store.instincts, cap);
  if (pruned.length === 0) {
    console.log(`[prune] ${store.instincts.length}/${cap} — nothing to prune`);
  } else if (dryRun) {
    console.log(`[prune] dry-run: would prune ${pruned.length} (${pruned.map((p) => p.id).join(", ")})`);
  } else {
    saveStore({ instincts: kept });
    console.log(`[prune] pruned ${pruned.length} lowest-confidence instincts; ${kept.length} kept`);
  }
}
