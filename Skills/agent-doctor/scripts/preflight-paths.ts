#!/usr/bin/env bun
/**
 * preflight-paths.ts — verify that all given file paths exist on disk.
 * Exits 0 if all paths are present. Exits 1 and prints "BROKEN PATH: <path>"
 * for each missing file, then exits non-zero.
 *
 * Usage:
 *   bun preflight-paths.ts /path/to/file1.ts /path/to/file2.ts ...
 */
import { existsSync } from "fs";

const paths = process.argv.slice(2);

if (paths.length === 0) {
  console.error("Usage: preflight-paths.ts <path1> [path2] ...");
  process.exit(1);
}

let broken = 0;
for (const p of paths) {
  if (existsSync(p)) {
    console.log(`OK: ${p}`);
  } else {
    console.log(`BROKEN PATH: ${p}`);
    broken++;
  }
}

if (broken > 0) {
  console.error(`\nPreflight failed: ${broken} broken path(s) detected.`);
  process.exit(1);
}

console.log("\nAll paths verified.");
process.exit(0);
