// ZOU-451 instinct-harvester — observer CLI: the write/read surface for the
// behavioral pattern store at .zo/instincts/instincts.yaml.
//
// The "observer agent" role is played by the session agent itself: the
// extract-patterns Stop gate (ZOU-452) prompts it at session stop to review
// the conversation against the four qualifying criteria and, when a pattern
// qualifies, call `add` here. This keeps hook-path code deterministic (no LLM
// call, no API key dependency) while the entity with the richest view of the
// session — the agent — does the pattern judgment.
//
// Commands:
//   add   --trigger T --action A --domain D [--confidence 0.7] [--source session-observation]
//   brief [--top 5] [--context "prompt text"]     → session-briefing block (memory gate)
//   list  [--domain D]
//   stats
//   reinforce --id inst_NNN [--last-seen YYYY-MM-DD]  → daily-synthesis reinforcement

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { mergeCandidate, validateCandidate, type Instinct } from "./merge";
import { pruneInstincts, rankInstincts, INSTINCT_CAP } from "./prune";

export interface InstinctStore {
  instincts: Instinct[];
}

export const STORE_PATH =
  process.env.INSTINCT_STORE_PATH ?? "/home/workspace/.zo/instincts/instincts.yaml";

export function loadStore(path: string = STORE_PATH): InstinctStore {
  if (!existsSync(path)) return { instincts: [] };
  try {
    const raw = yamlLoad(readFileSync(path, "utf8"));
    const instincts = (raw as InstinctStore | null)?.instincts;
    return { instincts: Array.isArray(instincts) ? instincts : [] };
  } catch {
    // Fail-safe: unreadable store reads as empty — but snapshot it first so a
    // subsequent save can never silently clobber a corrupt-but-recoverable file.
    try {
      copyFileSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {}
    return { instincts: [] };
  }
}

export function saveStore(store: InstinctStore, path: string = STORE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlDump({ instincts: store.instincts }, { lineWidth: 100 }));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Domain-aware selection: domains mentioned in the context text rank first,
// then overall confidence order. Deterministic, no LLM.
export function selectForBriefing(
  instincts: Instinct[],
  top: number,
  context: string = "",
): Instinct[] {
  const ranked = rankInstincts(instincts);
  if (!context) return ranked.slice(0, top);
  const ctx = context.toLowerCase();
  const hit = (i: Instinct) => (ctx.includes(i.domain.toLowerCase()) ? 0 : 1);
  return [...ranked].sort((a, b) => hit(a) - hit(b)).slice(0, top);
}

export function renderBriefing(selected: Instinct[]): string {
  if (selected.length === 0) return "";
  const lines = selected.map(
    (i) => `- [${i.domain} ×${i.reinforced_count} @${i.confidence.toFixed(2)}] ${i.trigger} → ${i.action}`,
  );
  return `[Session Briefing — Instincts]\n${lines.join("\n")}`;
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const store = loadStore();

  switch (cmd) {
    case "add": {
      const cand = {
        trigger: argVal(args, "--trigger") ?? "",
        action: argVal(args, "--action") ?? "",
        domain: argVal(args, "--domain") ?? "",
        confidence: argVal(args, "--confidence") ? Number(argVal(args, "--confidence")) : undefined,
        source: argVal(args, "--source"),
      };
      const errors = validateCandidate(cand);
      if (errors.length > 0) {
        console.error(`[observer] rejected: ${errors.join("; ")}`);
        process.exit(1);
      }
      const { instincts, outcome } = mergeCandidate(store.instincts, cand, today());
      const { kept, pruned } = pruneInstincts(instincts, Number(process.env.INSTINCT_CAP ?? INSTINCT_CAP));
      saveStore({ instincts: kept });
      if (outcome.kind === "rejected") {
        console.error(`[observer] rejected: ${outcome.reasons.join("; ")}`);
        process.exit(1);
      }
      console.log(
        `[observer] ${outcome.kind}: ${outcome.instinct.id} (${outcome.instinct.domain}, conf=${outcome.instinct.confidence}, reinforced=${outcome.instinct.reinforced_count})` +
          (pruned.length > 0 ? ` — pruned ${pruned.length} over cap` : ""),
      );
      break;
    }
    case "brief": {
      const top = Number(argVal(args, "--top") ?? 5);
      const context = argVal(args, "--context") ?? "";
      const out = renderBriefing(selectForBriefing(store.instincts, top, context));
      if (out) console.log(out);
      break;
    }
    case "list": {
      const domain = argVal(args, "--domain");
      const items = rankInstincts(store.instincts).filter((i) => !domain || i.domain === domain);
      for (const i of items)
        console.log(`${i.id}  [${i.domain}] conf=${i.confidence} ×${i.reinforced_count} last=${i.last_seen}\n    ${i.trigger}\n    → ${i.action}`);
      console.log(`${items.length} instinct(s)`);
      break;
    }
    case "stats": {
      const byDomain = new Map<string, number>();
      for (const i of store.instincts) byDomain.set(i.domain, (byDomain.get(i.domain) ?? 0) + 1);
      console.log(
        JSON.stringify(
          {
            total: store.instincts.length,
            cap: INSTINCT_CAP,
            domains: Object.fromEntries(byDomain),
            store: STORE_PATH,
          },
          null,
          2,
        ),
      );
      break;
    }
    case "reinforce": {
      const id = argVal(args, "--id");
      const inst = store.instincts.find((i) => i.id === id);
      if (!inst) {
        console.error(`[observer] no instinct with id ${id}`);
        process.exit(1);
      }
      inst.reinforced_count += 1;
      inst.last_seen = argVal(args, "--last-seen") ?? today();
      saveStore(store);
      console.log(`[observer] reinforced ${inst.id} → ×${inst.reinforced_count} last=${inst.last_seen}`);
      break;
    }
    default:
      console.log(
        "usage: observer.ts <add|brief|list|stats|reinforce>\n" +
          "  add --trigger T --action A --domain D [--confidence 0.7] [--source session-observation]\n" +
          "  brief [--top 5] [--context text]\n  list [--domain D]\n  stats\n  reinforce --id inst_NNN",
      );
  }
}
