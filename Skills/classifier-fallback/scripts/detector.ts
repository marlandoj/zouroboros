#!/usr/bin/env bun
/**
 * Classifier-Fallback Detector (SIL-14 T2).
 *
 * Classifies model output to distinguish:
 *   - hard_failure (HTTP error, timeout — NOT this detector's job; healer handles these)
 *   - soft_block   (refusal, filtered-to-empty, truncated-with-disclaimer, policy flag)
 *   - genuine_empty (legitimate empty result, not a classifier block)
 *   - ok           (normal output, no classifier signal)
 *
 * When a soft_block is detected, consults the fallback map to determine the
 * action: fallback to another model, human review, or refuse-by-design.
 *
 * Pure, importable, no network. Reads catalog + map from assets/.
 */
import { parseArgs } from "node:util";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const ASSETS_DIR = join(SCRIPT_DIR, "..", "assets");

export type BlockType = "refusal" | "filtered_empty" | "truncated_disclaimer" | "policy_flag";
export type ClassifyResult = "ok" | "soft_block" | "genuine_empty" | "hard_failure";
export type FallbackAction = "fallback" | "human_review" | "refuse_by_design";

export interface PatternMatch {
  block_type: BlockType;
  regex: string;
  confidence: number;
  description: string;
  matched_text: string;
}

export interface DetectionResult {
  result: ClassifyResult;
  block_type?: BlockType;
  confidence: number;
  matches: PatternMatch[];
  provider: string;
  output_length: number;
}

export interface FallbackDecision {
  domain: string;
  action: FallbackAction;
  fallback_model?: string;
  fallback_label?: string;
  reason?: string;
  escalate_after_fallback_fail: boolean;
}

// ---------------------------------------------------------------------------
// Catalog loading
// ---------------------------------------------------------------------------

function loadCatalog(): Record<string, any> {
  const p = join(ASSETS_DIR, "classifier-catalog.json");
  if (!existsSync(p)) throw new Error(`classifier-catalog.json not found at ${p}`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

function loadFallbackMap(): Record<string, any> {
  const p = join(ASSETS_DIR, "fallback-map.json");
  if (!existsSync(p)) throw new Error(`fallback-map.json not found at ${p}`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

// ---------------------------------------------------------------------------
// T2: Detector — classify model output
// ---------------------------------------------------------------------------

/**
 * Classify a model output against the classifier-signal catalog.
 *
 * @param output  The raw model output string
 * @param provider Provider key (e.g. "anthropic", "openai") — falls back to generic
 * @param minConf  Minimum confidence threshold for a match (default 0.5)
 * @returns DetectionResult with classification + matched patterns
 */
export function classifyOutput(
  output: string,
  provider: string = "generic",
  minConf: number = 0.5,
): DetectionResult {
  const catalog = loadCatalog();
  const trimmed = output.trim();
  const matches: PatternMatch[] = [];

  // Get provider-specific patterns, fall back to generic
  const providerCatalog = catalog.providers?.[provider]?.patterns ?? {};
  const genericCatalog = catalog.generic_patterns ?? {};

  // Merge: provider patterns take precedence, generic fills gaps
  const allPatternGroups = new Set<string>([
    ...Object.keys(providerCatalog),
    ...Object.keys(genericCatalog),
  ]);

  for (const group of allPatternGroups) {
    const providerPatterns = providerCatalog[group] ?? [];
    const genericPatterns = genericCatalog[group] ?? [];

    // Check provider patterns first (higher confidence), then generic
    for (const patterns of [providerPatterns, genericPatterns]) {
      for (const p of patterns) {
        if (p.confidence < minConf) continue;
        try {
          const re = new RegExp(p.regex, "i");
          const m = trimmed.match(re);
          if (m) {
            matches.push({
              block_type: group as BlockType,
              regex: p.regex,
              confidence: p.confidence,
              description: p.description ?? "",
              matched_text: m[0].slice(0, 100),
            });
          }
        } catch {
          // Invalid regex — skip silently
        }
      }
    }
  }

  // Deduplicate matches (same block_type + regex)
  const seen = new Set<string>();
  const deduped = matches.filter((m) => {
    const key = `${m.block_type}:${m.regex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Classify
  if (deduped.length === 0) {
    // No classifier signal. Is it genuinely empty?
    if (trimmed.length === 0) {
      return {
        result: "genuine_empty",
        confidence: 1.0,
        matches: [],
        provider,
        output_length: 0,
      };
    }
    return {
      result: "ok",
      confidence: 1.0,
      matches: [],
      provider,
      output_length: trimmed.length,
    };
  }

  // Soft block detected — take the highest-confidence match
  const best = deduped.reduce((a, b) => (a.confidence > b.confidence ? a : b));
  return {
    result: "soft_block",
    block_type: best.block_type,
    confidence: best.confidence,
    matches: deduped,
    provider,
    output_length: trimmed.length,
  };
}

// ---------------------------------------------------------------------------
// T3: Fallback routing — consult the per-domain map
// ---------------------------------------------------------------------------

/**
 * Given a detected soft block, consult the fallback map for the action.
 *
 * @param domain Task domain (e.g. "security", "bio", "distillation", "general")
 * @returns FallbackDecision with the action to take
 */
export function routeFallback(domain: string = "general"): FallbackDecision {
  const map = loadFallbackMap();
  const domainConfig = map.domains?.[domain] ?? map.domains?.["general"] ?? map.defaults;

  return {
    domain,
    action: domainConfig.action as FallbackAction,
    fallback_model: domainConfig.fallback_model,
    fallback_label: domainConfig.fallback_label,
    reason: domainConfig.reason,
    escalate_after_fallback_fail: domainConfig.escalate_after_fallback_fail ?? false,
  };
}

// ---------------------------------------------------------------------------
// T4: Audit logging — append to the ledger
// ---------------------------------------------------------------------------

const LEDGER_PATH = join(ASSETS_DIR, "classifier-blocks.jsonl");

/**
 * Log a classifier block + fallback to the audit ledger.
 */
export function logBlock(params: {
  timestamp?: string;
  provider: string;
  model: string;
  task_class: string;
  domain: string;
  detection: DetectionResult;
  fallback: FallbackDecision;
  task_id?: string;
}): void {
  const entry = {
    timestamp: params.timestamp ?? new Date().toISOString(),
    provider: params.provider,
    model: params.model,
    task_class: params.task_class,
    domain: params.domain,
    detection: params.detection,
    fallback: params.fallback,
    task_id: params.task_id,
  };

  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      output: { type: "string", short: "o" },
      provider: { type: "string", short: "p", default: "generic" },
      domain: { type: "string", short: "d", default: "general" },
      model: { type: "string", short: "m", default: "unknown" },
      "task-class": { type: "string", short: "t", default: "unknown" },
      "min-confidence": { type: "string", default: "0.5" },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? "help";

  if (command === "classify") {
    const output = values.output ?? "";
    const result = classifyOutput(output, values.provider, parseFloat(values["min-confidence"]));
    const fallback = routeFallback(values.domain);

    // If soft block detected, log to ledger
    if (result.result === "soft_block") {
      logBlock({
        provider: values.provider,
        model: values.model,
        task_class: values["task-class"],
        domain: values.domain,
        detection: result,
        fallback,
      });
    }

    console.log(JSON.stringify({
      detection: result,
      fallback: result.result === "soft_block" ? fallback : undefined,
    }, null, 2));
  } else if (command === "map") {
    const fallback = routeFallback(values.domain);
    console.log(JSON.stringify(fallback, null, 2));
  } else if (command === "test") {
    await runTests();
  } else {
    console.log(`Usage:
  detector.ts classify --output "model output" --provider anthropic --domain security
  detector.ts map --domain security
  detector.ts test
`);
  }
}

// ---------------------------------------------------------------------------
// Built-in test suite (T2/T3/T4 acceptance)
// ---------------------------------------------------------------------------

async function runTests() {
  let pass = 0, fail = 0;

  function assert(cond: boolean, label: string) {
    if (cond) { pass++; console.log(`  (pass) ${label}`); }
    else { fail++; console.log(`  (FAIL) ${label}`); }
  }

  console.log("\n=== T2: classifyOutput ===");

  // Refusal detection (Anthropic)
  const r1 = classifyOutput("I can't help with that request.", "anthropic");
  assert(r1.result === "soft_block", "anthropic refusal → soft_block");
  assert(r1.block_type === "refusal", "block_type = refusal");
  assert(r1.confidence >= 0.9, "confidence ≥ 0.9");

  // Apologetic refusal (OpenAI)
  const r2 = classifyOutput("Sorry, I can't generate that content.", "openai");
  assert(r2.result === "soft_block", "openai apology refusal → soft_block");
  assert(r2.block_type === "refusal", "block_type = refusal");

  // Policy-cited refusal
  const r3 = classifyOutput("That goes against our content policy.", "anthropic");
  assert(r3.result === "soft_block", "policy refusal → soft_block");

  // Filtered empty
  const r4 = classifyOutput("   ", "anthropic");
  assert(r4.result === "soft_block", "anthropic filtered empty → soft_block (low conf)");
  assert(r4.block_type === "filtered_empty", "block_type = filtered_empty");

  // Truncated with disclaimer
  const r5 = classifyOutput("Here's the result, but I've filtered some potentially sensitive content.", "openai");
  assert(r5.result === "soft_block", "truncated disclaimer → soft_block");

  // Normal output — ok
  const r6 = classifyOutput("function add(a, b) { return a + b; }", "anthropic");
  assert(r6.result === "ok", "normal code → ok");

  // Empty output with no provider → genuine_empty
  const r7 = classifyOutput("", "generic", 0.6);
  assert(r7.result === "genuine_empty", "empty generic (high threshold) → genuine_empty");

  // Generic fallback (provider unknown)
  const r8 = classifyOutput("I cannot help with that.", "unknown_provider");
  assert(r8.result === "soft_block", "unknown provider → generic pattern catches refusal");

  console.log("\n=== T3: routeFallback ===");

  const f1 = routeFallback("security");
  assert(f1.action === "fallback", "security → fallback");
  assert(!!f1.fallback_model, "security has fallback_model");

  const f2 = routeFallback("bio");
  assert(f2.action === "human_review", "bio → human_review");

  const f3 = routeFallback("chem");
  assert(f3.action === "human_review", "chem → human_review");

  const f4 = routeFallback("distillation");
  assert(f4.action === "refuse_by_design", "distillation → refuse_by_design");
  assert(!f4.fallback_model, "distillation has NO fallback_model (refuse by design)");

  const f5 = routeFallback("nonexistent");
  assert(f5.action === "fallback", "unknown domain → defaults to fallback");

  console.log("\n=== T4: logBlock ===");

  // Write a test block to the ledger
  const testLedgerPath = join(ASSETS_DIR, "classifier-blocks.jsonl");
  const beforeSize = existsSync(testLedgerPath) ? readFileSync(testLedgerPath, "utf-8").length : 0;

  logBlock({
    provider: "anthropic",
    model: "test-model",
    task_class: "test",
    domain: "security",
    detection: r1,
    fallback: f1,
    task_id: "sil-14-test",
  });

  const afterSize = existsSync(testLedgerPath) ? readFileSync(testLedgerPath, "utf-8").length : 0;
  assert(afterSize > beforeSize, "ledger entry appended");

  console.log(`\n=== Results: ${pass} pass / ${fail} fail ===\n`);
  if (fail > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch(console.error);
}
