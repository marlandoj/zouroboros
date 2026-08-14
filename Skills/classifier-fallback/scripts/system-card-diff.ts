#!/usr/bin/env bun
/**
 * System-Card Diff — quarterly classifier-scope audit (SIL-14 T5).
 *
 * Fetches published system cards / policy pages from each provider, diffs them
 * against the last-known snapshot (stored in assets/), and flags any expanded
 * classifier scope to the operator. The first run is a baseline (no diff); 
 * subsequent runs flag new/expanded classifier boundaries.
 *
 * Usage:
 *   bun system-card-diff.ts                    # Full diff run
 *   bun system-card-diff.ts --baseline         # Force re-baseline (overwrite snapshots)
 *   bun system-card-diff.ts --json             # JSON output for agent consumption
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const SNAPSHOTS_DIR = join(SCRIPT_DIR, "..", "assets", "card-snapshots");
const CONFIG_PATH = join(SCRIPT_DIR, "..", "assets", "system-card-urls.json");

interface CardEntry {
  provider: string;
  label: string;
  urls: string[];
  classifierKeywords: string[];
}

interface DiffResult {
  provider: string;
  url: string;
  status: "baseline" | "unchanged" | "expanded" | "reduced" | "error";
  newKeywords: string[];
  removedKeywords: string[];
  error?: string;
}

async function fetchUrl(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Zo-SystemCardAudit/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

function extractKeywordHits(content: string, keywords: string[]): string[] {
  const lower = content.toLowerCase();
  return keywords.filter(k => lower.includes(k.toLowerCase()));
}

async function runDiff(forceBaseline: boolean): Promise<DiffResult[]> {
  if (!existsSync(CONFIG_PATH)) {
    console.error("No system-card-urls.json config found");
    return [];
  }
  const config: CardEntry[] = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const results: DiffResult[] = [];

  for (const entry of config) {
    for (const url of entry.urls) {
      const safeName = `${entry.provider}-${Buffer.from(url).toString("base64url").slice(0, 12)}.txt`;
      const snapPath = join(SNAPSHOTS_DIR, safeName);
      const hasSnapshot = existsSync(snapPath) && !forceBaseline;

      try {
        const content = await fetchUrl(url);
        const currentHits = extractKeywordHits(content, entry.classifierKeywords);

        if (!hasSnapshot) {
          writeFileSync(snapPath, content);
          results.push({
            provider: entry.provider, url, status: "baseline",
            newKeywords: currentHits, removedKeywords: [],
          });
        } else {
          const oldContent = readFileSync(snapPath, "utf-8");
          const oldHits = extractKeywordHits(oldContent, entry.classifierKeywords);
          writeFileSync(snapPath, content);
          const newKw = currentHits.filter(k => !oldHits.includes(k));
          const removedKw = oldHits.filter(k => !currentHits.includes(k));
          results.push({
            provider: entry.provider, url,
            status: newKw.length > 0 ? "expanded" : removedKw.length > 0 ? "reduced" : "unchanged",
            newKeywords: newKw, removedKeywords: removedKw,
          });
        }
      } catch (e) {
        results.push({
          provider: entry.provider, url, status: "error",
          newKeywords: [], removedKeywords: [],
          error: (e as Error).message,
        });
      }
    }
  }
  return results;
}

const command = process.argv[2];
if (command === "--help" || !command) {
  console.log(`Usage:
  system-card-diff.ts scan          — diff current cards against baseline
  system-card-diff.ts baseline      — save current keywords as new baseline
`);
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
  },
  args: process.argv.slice(3),
  allowPositionals: true,
});

const isBaseline = command === "baseline";
const results = await runDiff(isBaseline);
const expanded = results.filter(r => r.status === "expanded");

if (values.json) {
  console.log(JSON.stringify({ results, expandedCount: expanded.length, timestamp: new Date().toISOString() }, null, 2));
} else {
  console.log("\n=== System-Card Classifier-Scope Diff ===\n");
  for (const r of results) {
    const icon = r.status === "expanded" ? "⚠️" : r.status === "baseline" ? "📋" : r.status === "error" ? "❌" : "✅";
    console.log(`${icon} ${r.provider}: ${r.status} — ${r.url}`);
    if (r.newKeywords.length) console.log(`   NEW classifier keywords: ${r.newKeywords.join(", ")}`);
    if (r.removedKeywords.length) console.log(`   REMOVED keywords: ${r.removedKeywords.join(", ")}`);
    if (r.error) console.log(`   Error: ${r.error}`);
  }
  if (isBaseline) {
    console.log("\n📋 Baseline saved. Run 'scan' next quarter to detect scope changes.");
  } else if (expanded.length) {
    console.log(`\n⚠️  EXPANDED CLASSIFIER SCOPE DETECTED on ${expanded.length} provider(s). Review the new keywords above.`);
  } else {
    console.log("\n✅ No expanded classifier scope detected.");
  }
}
