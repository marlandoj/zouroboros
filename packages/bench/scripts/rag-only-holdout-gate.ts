#!/usr/bin/env bun
/**
 * RAG-Only Holdout Gate — generalization veto for the rag-only-prompt-tune autoloop.
 *
 * The autoloop optimizes answer_accuracy_pct on seed-100 (90 questions). That single
 * metric is Goodhart-exposed: a prompt can win on seed-100 by overfitting its phrasing.
 * This gate runs the SAME candidate prompt against the unseen seed-hard set (30 harder
 * paraphrased questions) and FAILS (exit 1) if accuracy regresses below the committed
 * baseline floor by more than the tolerance. A failed gate => non-zero Run Command =>
 * the engine treats the experiment as crashed and does not promote it.
 *
 * It mirrors autoloop-hello's `npm test && node measure.mjs`: the gate the optimizer
 * cannot touch (this script + seed-hard.json + the floor are Read-Only) runs alongside
 * the optimized metric, so speed/accuracy cannot be bought by breaking generalization.
 *
 * Mechanism:
 *   1. Run the adapter against seed-hard.json with the candidate prompt (RAG_ONLY_PROMPT_FILE).
 *      Embeddings are built fresh (no RAG_ONLY_BENCH_DB) so retrieval hits the seed-hard corpus.
 *   2. Parse METRIC= (answer accuracy) from the adapter output.
 *   3. Floor logic:
 *        - floor file missing  -> write this score as the baseline floor, PASS (exit 0).
 *          (This is the autoloop experiment-0 baseline run.)
 *        - floor file present  -> PASS iff hard_acc >= floor - tolerance, else REJECT (exit 1).
 *
 * The gate never emits a METRIC= line, so it cannot clobber the seed-100 metric the engine
 * extracts from /tmp/autoloop-rag-only.log.
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";

const BENCH = "/home/workspace/zouroboros/packages/bench";
const ADAPTER = `${BENCH}/adapters/rag-only-adapter.ts`;
const SEED_HARD = `${BENCH}/data/rag-only/seed-hard.json`;
const OUTPUT_DIR = `${BENCH}/data/runs/autoloop-holdout/`;
const FLOOR_FILE = `${BENCH}/data/rag-only/seed-hard-floor.txt`;
const HARD_LOG = "/tmp/autoloop-rag-only-hard.log";

const PROMPT_FILE =
  process.env.RAG_ONLY_PROMPT_FILE ?? `${BENCH}/data/rag-only/answer-prompt.md`;
const TOLERANCE_PP = parseFloat(process.env.HOLDOUT_TOLERANCE_PP ?? "5.0");

function fail(msg: string): never {
  console.error(`HOLDOUT GATE REJECT: ${msg}`);
  process.exit(1);
}

console.log(`[holdout] running seed-hard confirmation with prompt: ${PROMPT_FILE}`);

const run = spawnSync(
  "bun",
  [
    ADAPTER,
    "--dataset",
    SEED_HARD,
    "--output",
    OUTPUT_DIR,
    "--retriever",
    "rag-core",
  ],
  {
    encoding: "utf-8",
    env: { ...process.env, RAG_ONLY_PROMPT_FILE: PROMPT_FILE },
    // RAG_ONLY_BENCH_DB intentionally unset: build seed-hard embeddings fresh.
    maxBuffer: 64 * 1024 * 1024,
  },
);

const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
try {
  writeFileSync(HARD_LOG, out);
} catch {
  /* best effort */
}

if (run.status !== 0) {
  fail(`seed-hard adapter exited ${run.status}. Last output:\n${out.slice(-800)}`);
}

const matches = [...out.matchAll(/^METRIC=([0-9.]+)/gm)];
if (matches.length === 0) {
  fail(`no METRIC= emitted by seed-hard run. Last output:\n${out.slice(-800)}`);
}
const hardAcc = parseFloat(matches[matches.length - 1][1]);
if (!Number.isFinite(hardAcc)) {
  fail(`unparseable seed-hard accuracy: ${matches[matches.length - 1][1]}`);
}

if (!existsSync(FLOOR_FILE)) {
  writeFileSync(FLOOR_FILE, `${hardAcc.toFixed(2)}\n`);
  console.log(
    `[holdout] BASELINE: seed-hard accuracy ${hardAcc.toFixed(2)}% recorded as floor (${FLOOR_FILE}). PASS.`,
  );
  process.exit(0);
}

const floor = parseFloat(readFileSync(FLOOR_FILE, "utf-8").trim());
if (!Number.isFinite(floor)) {
  fail(`floor file ${FLOOR_FILE} is unparseable: "${readFileSync(FLOOR_FILE, "utf-8").trim()}"`);
}

const threshold = floor - TOLERANCE_PP;
if (hardAcc >= threshold) {
  console.log(
    `[holdout] PASS: seed-hard ${hardAcc.toFixed(2)}% >= floor ${floor.toFixed(2)}% - tol ${TOLERANCE_PP}pp (= ${threshold.toFixed(2)}%).`,
  );
  process.exit(0);
}

fail(
  `seed-hard ${hardAcc.toFixed(2)}% < floor ${floor.toFixed(2)}% - tol ${TOLERANCE_PP}pp (= ${threshold.toFixed(2)}%). ` +
    `This prompt gains on seed-100 but regresses on the unseen seed-hard set — it overfits. Revise to generalize.`,
);
