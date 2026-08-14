#!/usr/bin/env bun
/**
 * Build a paraphrased ZouroBench seed where the cross-persona-transfer
 * questions are rewritten to use synonyms/oblique references that defeat FTS.
 *
 * Same facts, same answers, same personas/pools — only the question wording
 * changes. This isolates whether semantic retrieval adds value vs FTS.
 *
 * Usage: bun scripts/build-paraphrased-seed.ts
 */

import { readFileSync, writeFileSync } from "fs";

const SRC = "data/zourobench/seed.json";
const OUT = "data/zourobench/seed-paraphrased.json";

// id → paraphrased question. Preserves type/queryPersona/sourcePersona/answer.
const PARAPHRASES: Record<string, string> = {
  "cp-01": "As junior-dev, what task-distribution scheme does the backend-architect document?",
  "cp-02": "As junior-dev, what release-pipeline gating does alaric require?",
  "cp-03": "As alaric, can you retrieve the security auditor's credential-leakage incident details?",
  "cp-04": "As content-strategist, what is the risk-adjusted return of the Stochastic RSI strategy?",
  "cp-05": "As security-auditor, what is the current zouroboros release identifier?",
  "cp-06": "As backend-architect, what content-presentation conventions exist?",
  "cp-07": "As alaric, what cross-process communication channels does the swarm offer?",
  "cp-08": "As junior-dev, what allocation-limit guideline applies to single holdings in trading?",
  "cp-09": "As security-auditor, what task-orchestration patterns does the swarm support?",
  "cp-10": "As financial-advisor, how does the security auditor mandate secrets be handled?",
  "cp-11": "As alaric, what rollout-related facts are visible to you?",
  "cp-12": "As junior-dev, from which other personas can you draw context?",
  "cp-13": "As content-strategist, what promotion-related information is available in your accessible pool?",
  "cp-14": "As alaric, what does the financial advisor know about digital-asset benchmark strategies?",
  "cp-15": "As security-auditor, how does alaric handle runtime configuration values for services?",
  "adv-cp-01": "As junior-dev, can you reach the financial-advisor's maximum-single-holding allocation guideline?",
  "adv-cp-02": "Does the content-strategist have visibility into the security auditor's cross-site request forgery report?",
  "adv-cp-03": "As backend-architect, can you reach the financial-advisor's downside-exit threshold through the dev-pool?",
};

const seed = JSON.parse(readFileSync(SRC, "utf-8"));

const original = seed.questions["cross-persona-transfer"];
const rewritten = original.map((q: any) => {
  const p = PARAPHRASES[q.id];
  if (!p) {
    console.warn(`⚠️  No paraphrase for ${q.id} — keeping original`);
    return q;
  }
  return { ...q, question: p, originalQuestion: q.question };
});

seed.questions["cross-persona-transfer"] = rewritten;
seed.metadata = {
  ...seed.metadata,
  name: (seed.metadata.name ?? "ZouroBench") + " (paraphrased)",
  description: "Paraphrased cross-persona questions to defeat FTS — isolates semantic-retrieval contribution.",
};

writeFileSync(OUT, JSON.stringify(seed, null, 2));
console.log(`✅ Wrote ${OUT}`);
console.log(`   Paraphrased ${Object.keys(PARAPHRASES).length} cross-persona questions`);
