#!/usr/bin/env bun
/**
 * AI Engineer Learning — Query + Research interface.
 *
 * Searches the `ai-engineer-videos` Qdrant collection and optionally runs
 * deep research on the retrieved content. Designed for use by the AI Engineer
 * persona when building on Zouroboros.
 *
 * Usage:
 *   bun query.ts "How to build durable agents"
 *   bun query.ts "MCP security patterns" --top 10
 *   bun query.ts "context management" --research     (deep-research pipeline)
 *   bun query.ts --list-topics                        (show topic clusters)
 *   bun query.ts --recent                             (most recent videos)
 *
 * Output: Markdown report with citations, saved to notebooks/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyEvidenceReadinessGate,
  evidenceGateConfigFromEnv,
  formatEvidenceReadinessLines,
} from "./evidence-readiness";

if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^export\s+(\w+)=["']?([^"']*)["']?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

const { embeddings: mcEmbeddings } = await import(
  "../../zo-memory-system/scripts/model-client.ts"
);

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "ai-engineer-videos";
const NOTEBOOKS_DIR = "/home/workspace/Projects/ai-engineer-learning/notebooks";

function qHeaders() {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}

async function searchQdrant(query: string, top: number = 5): Promise<any[]> {
  const embResult = await mcEmbeddings(query);
  if (!embResult.embedding) throw new Error("Failed to embed query");

  const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: "POST",
    headers: qHeaders(),
    body: JSON.stringify({
      vector: embResult.embedding,
      limit: top,
      with_payload: true,
      score_threshold: 0.20,
    }),
  });
  if (!r.ok) throw new Error(`Qdrant search: ${r.status} ${await r.text()}`);
  const data = await r.json() as any;
  return data.result || [];
}

async function scrollRecent(limit: number = 20): Promise<any[]> {
  const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
    method: "POST",
    headers: qHeaders(),
    body: JSON.stringify({ limit, with_payload: true, with_vector: false }),
  });
  if (!r.ok) throw new Error(`Qdrant scroll: ${r.status} ${await r.text()}`);
  const data = await r.json() as any;
  return data.result?.points || [];
}

export function applyQueryEvidenceReadiness(
  results: any[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return applyEvidenceReadinessGate(results, evidenceGateConfigFromEnv(env));
}

function groupByVideo(results: any[]): Map<string, { chunks: any[]; score: number }> {
  const groups = new Map<string, { chunks: any[]; score: number }>();
  for (const r of results) {
    const vid = r.payload?.video_id || "unknown";
    const existing = groups.get(vid);
    if (existing) {
      existing.chunks.push(r);
      existing.score = Math.max(existing.score, r.score);
    } else {
      groups.set(vid, { chunks: [r], score: r.score });
    }
  }
  return groups;
}

function extractTitle(content: string): string {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1] : "Unknown Title";
}

function extractDuration(content: string): string {
  const match = content.match(/\*\*Duration:\*\*\s*(.+)/);
  return match ? match[1] : "?";
}

function extractTopics(content: string): string[] {
  // Simple topic extraction from common AI engineering keywords
  const keywords = [
    "agent", "MCP", "RAG", "eval", "context", "embedding", "LLM", "fine-tuning",
    "orchestration", "security", "observability", "voice", "multimodal", "skills",
    "deployment", "scale", "benchmark", "prompt", "workflow", "memory",
    "code generation", "testing", "autonomous", "durable", "infrastructure",
  ];
  const lower = content.toLowerCase();
  return keywords.filter(k => lower.includes(k.toLowerCase()));
}

async function runQuery(query: string, top: number, doResearch: boolean) {
  console.log(`\n🔍 Searching: "${query}"\n`);

  let results = await searchQdrant(query, top);
  if (results.length === 0) {
    // Fall back to scroll if semantic search returns nothing
    console.log("No semantic results, trying scroll...");
    results = await scrollRecent(top * 2);
  }

  if (results.length === 0) {
    console.log("No results found. The collection may be empty — run ingestion first.");
    return;
  }

  const evidenceGate = applyQueryEvidenceReadiness(results);
  results = evidenceGate.hits;

  const groups = groupByVideo(results);
  const sorted = Array.from(groups.entries())
    .sort((a, b) => b[1].score - a[1].score);

  // Build report
  const timestamp = new Date().toISOString().split("T")[0];
  let report = `# AI Engineer Research: "${query}"\n\n`;
  report += `**Date:** ${timestamp} | **Results:** ${results.length} chunks from ${groups.size} videos\n\n`;
  if (evidenceGate.mode === "annotate") {
    report += `**Evidence readiness:** ${evidenceGate.cohort.meetingThreshold}/${evidenceGate.cohort.total} hits meet \`${evidenceGate.minTier}\`. ${evidenceGate.synthesis.reason}.\n\n`;
  }
  report += `---\n\n## Key Findings\n\n`;

  for (const [vidId, group] of sorted) {
    const content = group.chunks[0]?.payload?.content || "";
    const title = group.chunks[0]?.payload?.title || extractTitle(content);
    const duration = extractDuration(content);
    const topics = extractTopics(content);

    report += `### ${title}\n`;
    report += `- **Video:** [${vidId}](https://www.youtube.com/watch?v=${vidId}) | **Duration:** ${duration} | **Score:** ${group.score.toFixed(3)}\n`;
    if (evidenceGate.mode === "annotate") {
      report += `- **Readiness and provenance (${group.chunks.length} hits):**\n`;
      report += `${formatEvidenceReadinessLines(group.chunks, evidenceGate.minTier)}\n`;
    }
    if (topics.length > 0) report += `- **Topics:** ${topics.join(", ")}\n`;
    report += `\n**Relevant excerpt:**\n> ${group.chunks[0]?.payload?.content?.slice(0, 500) || "N/A"}...\n\n`;
  }

  report += `---\n\n## Recommendations for Zouroboros\n\n`;
  report += `_Context-specific recommendations to be filled by AI Engineer persona based on retrieved content._\n\n`;

  if (doResearch) {
    report += `## Deep Research Pipeline\n\n`;
    report += `The deep-research skill can be invoked for these topics:\n`;
    const allTopics = new Set<string>();
    for (const [, group] of sorted) {
      const content = group.chunks[0]?.payload?.content || "";
      for (const t of extractTopics(content)) allTopics.add(t);
    }
    report += Array.from(allTopics).map(t => `- ${t}`).join("\n");
    report += `\n\n**To run deep research:** Switch to deep-research skill and process the top videos.\n`;
  }

  // Save to notebooks
  mkdirSync(NOTEBOOKS_DIR, { recursive: true });
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const outPath = join(NOTEBOOKS_DIR, `research-${slug}-${timestamp}.md`);
  writeFileSync(outPath, report);

  console.log(report);
  console.log(`\n📓 Saved: ${outPath}`);
}

async function listTopics() {
  console.log("\n📊 Topic Analysis — Scanning collection...\n");

  const results = await scrollRecent(500);
  const topicCounts = new Map<string, number>();
  const recentVideos = new Set<string>();

  for (const r of results) {
    const content = r.payload?.content || "";
    const vid = r.payload?.video_id;
    if (vid) recentVideos.add(vid);
    for (const t of extractTopics(content)) {
      topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
    }
  }

  const sorted = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`Top topics across ${recentVideos.size} videos (sampled):\n`);
  for (const [topic, count] of sorted.slice(0, 30)) {
    const bar = "█".repeat(Math.round(count / 2));
    console.log(`  ${topic.padEnd(20)} ${String(count).padStart(3)} ${bar}`);
  }
}

async function showRecent() {
  console.log("\n📺 Most Recent Videos Indexed:\n");
  const results = await scrollRecent(100);

  const seen = new Set<string>();
  const videos: { id: string; title: string; duration: string }[] = [];

  for (const r of results) {
    const vid = r.payload?.video_id;
    if (!vid || seen.has(vid)) continue;
    seen.add(vid);

    const content = r.payload?.content || "";
    videos.push({
      id: vid,
      title: extractTitle(content),
      duration: extractDuration(content),
    });
  }

  for (const v of videos.slice(0, 50)) {
    console.log(`  [${v.id}](https://www.youtube.com/watch?v=${v.id}) — ${v.title} (${v.duration})`);
  }
  console.log(`\n  ... and ${Math.max(0, videos.length - 50)} more`);
}

// ── Main ────────────────────────────────────────────────────────────────
async function main(args: string[]): Promise<void> {
  if (args.includes("--list-topics")) {
    await listTopics();
  } else if (args.includes("--recent")) {
    await showRecent();
  } else if (args.length >= 1) {
    const topIdx = args.indexOf("--top");
    const top = topIdx >= 0 ? parseInt(args[topIdx + 1]) || 5 : 5;
    const doResearch = args.includes("--research");
    const skipNext = new Set<number>();
    if (topIdx >= 0) skipNext.add(topIdx + 1);
    const query = args
      .filter((a, i) => !a.startsWith("--") && !skipNext.has(i))
      .join(" ");
    if (query.trim()) {
      await runQuery(query.trim(), top, doResearch);
    } else {
      console.log("Usage: bun query.ts \"search query\" [--top N] [--research]");
    }
  } else {
    console.log(`AI Engineer Learning Query Tool\n
Usage:
  bun query.ts "how to build durable agents"
  bun query.ts "MCP security" --top 10
  bun query.ts "eval strategies" --research
  bun query.ts --list-topics
  bun query.ts --recent
`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
