#!/usr/bin/env bun
/**
 * Visual Verifier — Capture script (SIL-13 T1).
 *
 * Captures a full-page screenshot of a URL via the agent-browser CLI.
 * Workflow: open → hydrate (sleep) → screenshot → return path.
 *
 * Usage:
 *   bun capture.ts --url "http://localhost:3099/route" --output /tmp/shot.png
 *   bun capture.ts --url "https://example.com" --output /tmp/shot.png --hydrate-ms 5000
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    output: { type: "string" },
    "hydrate-ms": { type: "string", default: "3000" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help || !values.url || !values.output) {
  console.log(`Usage: bun capture.ts --url <url> --output <path> [--hydrate-ms <ms>]

Options:
  --url          URL to capture (required)
  --output       Output PNG path (required)
  --hydrate-ms   Milliseconds to wait after open for hydration (default 3000)
  --help         Show this help
`);
  process.exit(values.help ? 0 : 1);
}

const url = values.url;
const output = values.output;
const hydrateMs = parseInt(values["hydrate-ms"] || "3000", 10);

// Ensure output directory exists
const outDir = dirname(output);
if (outDir && !existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

// Step 1: open the URL
try {
  execSync(`agent-browser open "${url}"`, { timeout: 15000, stdio: "pipe" });
} catch (e) {
  console.error(`capture: failed to open ${url}: ${(e as Error).message}`);
  process.exit(1);
}

// Step 2: hydrate — give the SPA time to render
if (hydrateMs > 0) {
  execSync(`sleep ${(hydrateMs / 1000).toFixed(1)}`, { stdio: "pipe" });
}

// Step 3: full-page screenshot
try {
  execSync(`agent-browser screenshot "${output}" --full`, { timeout: 15000, stdio: "pipe" });
} catch (e) {
  console.error(`capture: failed to screenshot to ${output}: ${(e as Error).message}`);
  process.exit(1);
}

// Verify the file was created
if (!existsSync(output)) {
  console.error(`capture: screenshot was not created at ${output}`);
  process.exit(1);
}

// Emit the path on stdout for the caller
console.log(output);
