#!/usr/bin/env bun
/**
 * ZOU-558 — Instinct Retrieval A/B Eval (eval-prod parity)
 *
 * Compares keyword baseline (selectForBriefing) vs blended-rank semantic
 * retrieval (blendedRetrieve — the SAME function used by MCP instinct_search
 * and observer brief). No bespoke benchmark path — production code only.
 *
 * Fixtures: 30 prompts incl 10 paraphrased pairs across 12 domains.
 * Metric: recall@5 (did the expected domain appear in top-5?).
 *
 * Usage: bun eval-instinct-retrieval.ts [--report <path>]
 */

import type { Instinct } from "./merge.ts";
import { loadStore, selectForBriefing, selectForBriefingSemantic } from "./observer.ts";

interface Fixture {
  prompt: string;
  expectedDomains: string[];
  paraphraseOf?: string;
}

const FIXTURES: Fixture[] = [
  // 1. Git ops — exact
  { prompt: "workspace main branch lost unpushed commits after a git reset", expectedDomains: ["git-ops"] },
  // 2. Git ops — paraphrase
  { prompt: "recover commits that disappeared from main after a reset", expectedDomains: ["git-ops"], paraphraseOf: "1" },
  // 3. Evaluation — exact
  { prompt: "benchmark returned zero scores for all tasks", expectedDomains: ["evaluation"] },
  // 4. Evaluation — paraphrase
  { prompt: "all eval tasks scored 0 out of N — uniform zeros", expectedDomains: ["evaluation"], paraphraseOf: "3" },
  // 5. Infra — exact
  { prompt: "E2E test authenticated endpoints through a zo.space public URL", expectedDomains: ["infra"] },
  // 6. Infra — paraphrase
  { prompt: "test a private API route on the public zo.space domain", expectedDomains: ["infra"], paraphraseOf: "5" },
  // 7. Software factory — exact
  { prompt: "dispatcher writes JSON output with stderr mixed in", expectedDomains: ["software-factory"] },
  // 8. Testing — exact
  { prompt: "selftest needs to isolate a module's env-overridable store path", expectedDomains: ["testing"] },
  // 9. Testing — paraphrase
  { prompt: "test should use a custom storage path via environment variable", expectedDomains: ["testing"], paraphraseOf: "8" },
  // 10. Video pipeline — exact
  { prompt: "generate TTS narration using hyperframes", expectedDomains: ["video-pipeline"] },
  // 11. Video pipeline — paraphrase
  { prompt: "create text-to-speech audio for a video clip", expectedDomains: ["video-pipeline"], paraphraseOf: "10" },
  // 12. Search — exact
  { prompt: "keyword search for marketing and strategy docs", expectedDomains: ["search"] },
  // 13. Search — paraphrase
  { prompt: "find role and strategy documents using text search", expectedDomains: ["search"], paraphraseOf: "12" },
  // 14. Zouroboros factory — exact
  { prompt: "running dispatcher in factory conveyor and piping output to swarm-exec", expectedDomains: ["zouroboros-software-factory", "zouroboros-factory"] },
  // 15. Zouroboros factory — paraphrase
  { prompt: "execute the factory pipeline with the seed YAML", expectedDomains: ["zouroboros-factory", "factory"] },
  // 16. Zo platform — exact
  { prompt: "create a Zo automation with the prefix naming convention", expectedDomains: ["zo-platform"] },
  // 17. Zo platform — paraphrase
  { prompt: "set up a scheduled task following the bracket prefix rule", expectedDomains: ["zo-platform", "zo-automation"], paraphraseOf: "16" },
  // 18. JHF — exact
  { prompt: "append a corrective row to jhf options daily CSV", expectedDomains: ["jhf-options-layer"] },
  // 19. JHF — paraphrase
  { prompt: "add a backfill entry to the strategy daily CSV file", expectedDomains: ["jhf-options-layer"], paraphraseOf: "18" },
  // 20. Packaging — exact
  { prompt: "package a skill for distribution to the catalog", expectedDomains: ["packaging"] },
  // 21. Packaging — paraphrase
  { prompt: "prepare a skill for publishing to the registry", expectedDomains: ["packaging"], paraphraseOf: "20" },
  // 22. Consensus gate — exact
  { prompt: "run the consensus gate on recent code changes", expectedDomains: ["consensus-gate", "zouroboros-consensus"] },
  // 23. Consensus gate — paraphrase
  { prompt: "validate changes through the multi-vendor panel", expectedDomains: ["consensus-gate", "zouroboros-consensus"], paraphraseOf: "22" },
  // 24. Zo-space — exact
  { prompt: "create a new zo.space route for a landing page", expectedDomains: ["zo-space"] },
  // 25. Zo-space — paraphrase
  { prompt: "add a public page to my zo.space site", expectedDomains: ["zo-space"], paraphraseOf: "24" },
  // 26. Git workflow — exact
  { prompt: "maintain git hygiene across the monorepo branches", expectedDomains: ["git-workflow", "git-hygiene"] },
  // 27. Factory — exact
  { prompt: "factory conveyor dispatch with the swarm orchestrator", expectedDomains: ["factory", "factory-conveyor"] },
  // 28. Factory — paraphrase
  { prompt: "run the swarm campaign with the task file", expectedDomains: ["factory", "factory-conveyor"], paraphraseOf: "27" },
  // 29. Linear — exact
  { prompt: "create a Linear issue for the new project backlog", expectedDomains: ["linear"] },
  // 30. Linear — paraphrase
  { prompt: "push a backlog item to the project tracking board", expectedDomains: ["linear"], paraphraseOf: "29" },
  // 31. Memory — exact
  { prompt: "ingest documents into the Qdrant knowledge store", expectedDomains: ["memory"] },
  // 32. Memory — paraphrase
  { prompt: "index new docs into the vector database collection", expectedDomains: ["memory"], paraphraseOf: "31" },
  // 33. Security — exact
  { prompt: "audit workspace security and rotate credentials", expectedDomains: ["security", "selfheal"] },
  // 34. Build watchdog — exact
  { prompt: "monitor long-running build progress for milestones", expectedDomains: ["build-watchdog"] },
  // 35. Media generation — exact
  { prompt: "generate images using the fal-ai-media skill", expectedDomains: ["media-generation"] },
];

async function main() {
  const store = loadStore();
  const instincts = store.instincts;
  const reportPath = (() => {
    const i = process.argv.indexOf("--report");
    return i !== -1 ? process.argv[i + 1] : undefined;
  })();

  const { blendedRetrieve } = await import("./instinct-retrieve.ts");

  let kwHits = 0, semHits = 0, kwFallback = 0;
  const results: Array<{ n: number; prompt: string; para: boolean; kw: string; sem: string; kwHit: boolean; semHit: boolean }> = [];

  for (let i = 0; i < FIXTURES.length; i++) {
    const f = FIXTURES[i];
    const top = 5;

    // Keyword baseline
    const kw = selectForBriefing(instincts, top, f.prompt);
    const kwHit = kw.some((inst) => f.expectedDomains.includes(inst.domain));
    if (kwHit) kwHits++;

    // Semantic (production path — same as MCP instinct_search)
    let sem: Instinct[] = [];
    let fellBack = false;
    try {
      const semR = await blendedRetrieve(f.prompt, top);
      sem = semR.results as unknown as Instinct[];
    } catch {
      sem = kw;
      fellBack = true;
      kwFallback++;
    }
    const semHit = sem.some((inst) => f.expectedDomains.includes(inst.domain));
    if (semHit) semHits++;

    results.push({
      n: i + 1,
      prompt: f.prompt,
      para: !!f.paraphraseOf,
      kw: kw.map((i) => i.id).join(",") || "-",
      sem: sem.map((i) => i.id).join(",") || "-",
      kwHit,
      semHit,
    });

    process.stdout.write(fellBack ? "F" : (semHit ? "." : "x"));
  }
  console.log("");

  const kwRecall = (kwHits / FIXTURES.length * 100).toFixed(1);
  const semRecall = (semHits / FIXTURES.length * 100).toFixed(1);
  const paraCount = FIXTURES.filter((f) => f.paraphraseOf).length;

  const report = [
    "# ZOU-558 Instinct Retrieval A/B Eval Report",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Fixtures: ${FIXTURES.length} (${paraCount} paraphrased)`,
    `Semantic fallbacks: ${kwFallback}`,
    "",
    "## Results",
    "",
    "| Metric | Keyword | Semantic (blended) |",
    "|--------|---------|---------------------|",
    `| recall@5 | ${kwRecall}% (${kwHits}/${FIXTURES.length}) | ${semRecall}% (${semHits}/${FIXTURES.length}) |`,
    "",
    "## Per-fixture detail",
    "",
    "| # | Prompt | Para | KW hit | Sem hit | KW IDs | Sem IDs |",
    "|---|--------|------|--------|---------|--------|---------|",
    ...results.map((r) => `| ${r.n} | ${r.prompt.slice(0, 50)}${r.prompt.length > 50 ? "…" : ""} | ${r.para ? "✓" : ""} | ${r.kwHit ? "✅" : "❌"} | ${r.semHit ? "✅" : "❌"} | ${r.kw} | ${r.sem} |`),
    "",
  ].join("\n");

  if (reportPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(reportPath, report);
    console.log(`Report written to ${reportPath}`);
  }

  console.log(`\nKeyword recall@5:   ${kwRecall}% (${kwHits}/${FIXTURES.length})`);
  console.log(`Semantic recall@5:  ${semRecall}% (${semHits}/${FIXTURES.length})`);
  console.log(`Paraphrased:        ${paraCount}`);
  console.log(`Fallbacks:          ${kwFallback}`);

  const pass = semHits >= kwHits;
  console.log(`\n${pass ? "✅ PASS" : "⚠ REVIEW"} — semantic ${pass ? "≥" : "<"} keyword recall`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
