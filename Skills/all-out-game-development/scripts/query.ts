#!/usr/bin/env bun
import { readFileSync } from "node:fs";

if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch {}
}

const { embeddings } = await import("../../zo-memory-system/scripts/model-client");
const { buildSparseVector } = await import("../../zo-memory-system/scripts/rag-pipeline");
const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "all-out-gamedev";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function help(): never {
  console.log("Usage: bun query.ts [--role director|engineer|art-ux|qa] [--limit 6] <query>");
  process.exit(0);
}

async function main() {
  if (process.argv.includes("--help")) help();
  const role = value("role") || "shared";
  const limit = Math.max(1, Math.min(20, Number(value("limit") || 6)));
  const skip = new Set(["--role", role, "--limit", String(value("limit") || "")]);
  const query = process.argv.slice(2).filter((item) => !skip.has(item)).join(" ").trim();
  if (!query) help();
  const retrievalQuery = `${role} ${query}`;
  const embedded = await embeddings(retrievalQuery);
  const sparse = buildSparseVector(retrievalQuery);
  const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(QDRANT_KEY ? { "api-key": QDRANT_KEY } : {}),
    },
    body: JSON.stringify({
      prefetch: [
        { query: embedded.embedding, using: "dense", limit: Math.max(limit * 4, 20) },
        { query: { indices: sparse.indices, values: sparse.values }, using: "sparse", limit: Math.max(limit * 4, 20) },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
    }),
  });
  if (!response.ok) throw new Error(`Qdrant query failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const results = (payload.result?.points || []).map((point: any) => ({
    score: point.score,
    title: point.payload?.title,
    section: point.payload?.section,
    url: point.payload?.url,
    source_type: point.payload?.source_type,
    role_tags: point.payload?.role_tags,
    content: point.payload?.content,
  }));
  console.log(JSON.stringify({ role, query, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
