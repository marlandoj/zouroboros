#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "ai-engineer-videos";
const CATALOG_FILE = "/home/workspace/Projects/ai-engineer-learning/channel-videos.json";

function headers() {
  const value: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) value["api-key"] = QDRANT_KEY;
  return value;
}

async function qdrant(path: string, body?: unknown) {
  const response = await fetch(`${QDRANT_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

const catalog = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as Array<{ id: string }>;
const catalogIds = new Set(catalog.map((video) => video.id));
const indexedIds = new Set<string>();
let transcriptPoints = 0;
let metadataPoints = 0;
let unclassifiedPoints = 0;
let offset: string | number | null = null;

do {
  const result = await qdrant(`/collections/${COLLECTION}/points/scroll`, {
    limit: 512,
    offset,
    with_payload: ["video_id", "source", "has_transcript", "content"],
    with_vector: false,
  });
  for (const point of result.result.points) {
    const payload = point.payload || {};
    const videoId = payload.video_id || payload.source;
    if (videoId) indexedIds.add(videoId);
    if (payload.has_transcript === false) metadataPoints++;
    else if (videoId && typeof payload.content === "string" && payload.content.length > 0) transcriptPoints++;
    else unclassifiedPoints++;
  }
  offset = result.result.next_page_offset ?? null;
} while (offset !== null);

const info = await qdrant(`/collections/${COLLECTION}`);
const missingIds = [...catalogIds].filter((id) => !indexedIds.has(id));
const unexpectedIds = [...indexedIds].filter((id) => !catalogIds.has(id));
const report = {
  status: info.result.status,
  points: info.result.points_count,
  catalogVideos: catalogIds.size,
  indexedVideos: indexedIds.size,
  missingCount: missingIds.length,
  missingSample: missingIds.slice(0, 20),
  unexpectedCount: unexpectedIds.length,
  unexpectedSample: unexpectedIds.slice(0, 20),
  transcriptPoints,
  metadataPoints,
  unclassifiedPoints,
};

console.log(JSON.stringify(report, null, 2));
if (
  report.status !== "green" ||
  report.missingCount > 0 ||
  report.unexpectedCount > 0 ||
  report.unclassifiedPoints > 0 ||
  report.transcriptPoints + report.metadataPoints !== report.points
) process.exit(1);
