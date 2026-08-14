#!/usr/bin/env bun
/**
 * Visual Verification Station — pipeline orchestrator (SIL-13 T3).
 *
 * Ties capture (T1) + verify (T2) into a single station call. After a maker
 * produces a visual deliverable (UI/route/site), the post-flight harness calls
 * this station. It captures a screenshot, runs the independent verifier, and
 * emits a structured verdict:
 *   - match → task is visually verified (exit 0)
 *   - mismatch → structured visual diff written for the maker's next iteration (exit 1)
 *
 * The maker does NOT self-declare done on visual tasks — this station is the exit
 * condition (per SIL-13 AC).
 *
 * Usage:
 *   bun station.ts --url http://localhost:3099/my-route \
 *     --criteria "uses amethyst+gold palette, hero section present" \
 *     --design-md /home/workspace/Projects/myproj/01-brand/DESIGN.md \
 *     --author "hf:zai-org/GLM-5.2" \
 *     --label "my-route" \
 *     --output-dir /tmp/visual-station
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    criteria: { type: "string" },
    "design-md": { type: "string" },
    "prior-screenshot": { type: "string" },
    author: { type: "string" },
    label: { type: "string", default: "unlabeled" },
    "output-dir": { type: "string", default: "/tmp/visual-station" },
    "hydrate-ms": { type: "string", default: "3000" },
    model: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help || !values.url || !values.criteria) {
  console.log(`Usage: bun station.ts --url <url> --criteria "<text>" [options]

Options:
  --url               URL to capture (required)
  --criteria          Acceptance criteria text (required)
  --design-md         Path to project DESIGN.md (optional)
  --prior-screenshot   Path to prior screenshot for regression check (optional)
  --author            Author model id (≠author constraint, optional)
  --label             Task label (default "unlabeled")
  --output-dir        Where to write artifacts (default /tmp/visual-station)
  --hydrate-ms        Hydration wait in ms before screenshot (default 3000)
  --model             Override verifier model (default gpt-4o)
  --help              Show this help

Exit codes:
  0 = visual match (task verified)
  1 = visual mismatch (rework diff written for the maker)
  2 = station error (capture or verify failed)

Artifacts written to --output-dir:
  screenshot-<label>.png    The captured screenshot
  verdict-<label>.json      The verifier's structured verdict
  visual-diff-<label>.json  On mismatch: the rework diff for the maker
`);
  process.exit(values.help ? 0 : 1);
}

const outputDir = values["output-dir"];
const label = values.label;

// Sanitize label for filenames
const safeLabel = label.replace(/[^a-zA-Z0-9-_]/g, "_");
const screenshotPath = join(outputDir, `screenshot-${safeLabel}.png`);
const verdictPath = join(outputDir, `verdict-${safeLabel}.json`);
const diffPath = join(outputDir, `visual-diff-${safeLabel}.json`);
const failuresLogPath = join(outputDir, "visual-failures.jsonl");

mkdirSync(outputDir, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: Capture screenshot
// ---------------------------------------------------------------------------
console.log(`📸 Capturing screenshot of ${values.url}...`);

try {
  const captureResult = spawnSync(
    "bun",
    [`${SCRIPT_DIR}/capture.ts`, "--url", values.url, "--output", screenshotPath, "--hydrate-ms", String(values["hydrate-ms"])],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 30000, encoding: "utf-8" },
  );
  if (captureResult.status !== 0) throw new Error(captureResult.stderr || `capture exited ${captureResult.status}`);
} catch (e) {
  console.error(`❌ Station: capture failed: ${(e as Error).message}`);
  process.exit(2);
}

if (!existsSync(screenshotPath)) {
  console.error("❌ Station: screenshot was not created");
  process.exit(2);
}

console.log(`✅ Screenshot saved: ${screenshotPath}`);

// ---------------------------------------------------------------------------
// Step 2: Run independent verifier
// ---------------------------------------------------------------------------
console.log(`🔍 Running visual verifier (≠author constraint active)...`);

const verifyArgs = [
  `${SCRIPT_DIR}/verify.ts`,
  "--screenshot", screenshotPath,
  "--criteria", values.criteria,
  "--label", label,
];

if (values["design-md"]) verifyArgs.push("--design-md", values["design-md"]);
if (values["prior-screenshot"]) verifyArgs.push("--prior-screenshot", values["prior-screenshot"]);
if (values.author) verifyArgs.push("--author", values.author);
if (values.model) verifyArgs.push("--model", values.model);

let verifyOutput: string;
try {
  const verifyResult = spawnSync("bun", verifyArgs, {
    encoding: "utf-8",
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (verifyResult.status !== 0) throw new Error(verifyResult.stderr || `verifier exited ${verifyResult.status}`);
  verifyOutput = verifyResult.stdout;
} catch (e) {
  console.error(`❌ Station: verifier failed: ${(e as Error).message}`);
  process.exit(2);
}

// Parse the verifier's JSON output
let verdict: {
  verdict: string;
  confidence: number;
  diffs: { issue: string; criterion: string; severity: string }[];
  summary: string;
};

try {
  verdict = JSON.parse(verifyOutput);
} catch (e) {
  console.error(`❌ Station: could not parse verifier output: ${verifyOutput.slice(0, 200)}`);
  process.exit(2);
}

// Save the verdict
writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));

// ---------------------------------------------------------------------------
// Step 3: Loop verdict — match or mismatch
// ---------------------------------------------------------------------------
const isMatch = verdict.verdict === "match" && (verdict.diffs || []).length === 0;

if (isMatch) {
  console.log(`\n✅ Visual verification PASSED for "${label}"`);
  console.log(`   Confidence: ${verdict.confidence}`);
  console.log(`   Summary: ${verdict.summary}`);
  console.log(`   Verifier model ≠ author: constraint satisfied`);
  console.log(`\n📋 Task is visually verified — the maker may declare done.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mismatch: emit structured visual diff for the maker
// ---------------------------------------------------------------------------
console.log(`\n❌ Visual verification FAILED for "${label}"`);
console.log(`   Confidence: ${verdict.confidence}`);
console.log(`   ${verdict.diffs.length} issue(s) found:\n`);

for (const d of verdict.diffs) {
  const icon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "🟢";
  console.log(`   ${icon} [${d.severity.toUpperCase()}] ${d.issue}`);
  console.log(`      Violates: ${d.criterion}\n`);
}

// Write the rework diff for the maker's next iteration
const reworkDiff = {
  timestamp: new Date().toISOString(),
  label,
  url: values.url,
  screenshot: screenshotPath,
  verdict: verdict.verdict,
  confidence: verdict.confidence,
  summary: verdict.summary,
  diffs: verdict.diffs,
  instruction:
    "The visual verifier found the above issues. Fix them and re-run the station. Do NOT self-declare done until the station returns a match.",
};

writeFileSync(diffPath, JSON.stringify(reworkDiff, null, 2));
console.log(`📝 Rework diff written: ${diffPath}`);

// Append to the failures log (for T5 compounding via extract-patterns gate)
appendFileSync(
  failuresLogPath,
  JSON.stringify({
    timestamp: reworkDiff.timestamp,
    label,
    url: values.url,
    diffs: verdict.diffs,
    confidence: verdict.confidence,
    model: values.model || process.env.VISUAL_VERIFIER_MODEL || "gpt-4o",
  }) + "\n",
);
console.log(`📊 Failure logged: ${failuresLogPath}`);

console.log(`\n🔄 The maker must rework based on the visual diff above.`);
process.exit(1);
