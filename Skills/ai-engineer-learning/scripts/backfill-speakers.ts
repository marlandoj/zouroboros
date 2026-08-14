#!/usr/bin/env bun
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CATALOG_FILE = "/home/workspace/Projects/ai-engineer-learning/channel-videos.json";
const ARTICLES_DIR = "/home/workspace/Articles";
const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "ai-engineer-videos";
const VERSION = 1;

export type SpeakerSource = "title" | "transcript_intro" | "none";

export interface SpeakerRecord {
  speakers: string[];
  source: SpeakerSource;
  confidence: number;
}

interface CatalogVideo {
  id: string;
  title: string;
  url: string;
  [key: string]: unknown;
}

interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown>;
}

function normalizeSpeaker(value: string): string {
  return value
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:]+$/, "")
    .trim();
}

function looksLikePerson(value: string): boolean {
  const tokens = normalizeSpeaker(value).split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  const lowercaseParticles = new Set(["da", "de", "del", "der", "di", "la", "le", "van", "von"]);
  const properTokens = tokens.filter((token) => {
    const clean = token.replace(/^[("'“”]+|[)"'“”]+$/g, "");
    return lowercaseParticles.has(clean.toLowerCase()) || /^[A-ZÀ-ÖØ-Ý][\p{L}'’.-]*$/u.test(clean);
  });
  return properTokens.length >= tokens.length - 1;
}

function splitSpeakerGroup(value: string): string[] {
  return value
    .split(/\s+(?:&|and)\s+/i)
    .map(normalizeSpeaker)
    .filter((candidate) => looksLikePerson(candidate));
}

function titleSuffix(title: string): string {
  const matches = [...title.matchAll(/\s(?:—|–|-)\s/g)];
  return matches.length ? title.slice(matches[matches.length - 1].index! + 3).trim() : "";
}

export function parseSpeakersFromTitle(title: string): SpeakerRecord {
  const suffix = titleSuffix(title)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^(?:with|featuring|feat\.?|ft\.?|by)\s+/i, "")
    .trim();
  if (!suffix) return { speakers: [], source: "none", confidence: 0 };

  const parts = suffix.split(/\s*,\s*/).map(normalizeSpeaker).filter(Boolean);
  const candidates = parts.length > 1 ? parts.slice(0, -1).flatMap(splitSpeakerGroup) : splitSpeakerGroup(suffix);
  const speakers = [...new Set(candidates)];
  if (speakers.length) {
    return { speakers, source: "title", confidence: parts.length > 1 ? 0.96 : 0.9 };
  }

  return { speakers: [], source: "none", confidence: 0 };
}

function transcriptIntroCandidates(text: string): string[] {
  const window = text.slice(text.indexOf("## Transcript") + 13, text.indexOf("## Transcript") + 14000);
  const patterns = [
    /\bmy name is\s+([A-ZÀ-ÖØ-Ý][\p{L}'’.-]+(?:\s+[A-ZÀ-ÖØ-Ý][\p{L}'’.-]+){1,3})/gu,
    /\bI(?:'m| am)\s+([A-ZÀ-ÖØ-Ý][\p{L}'’.-]+(?:\s+[A-ZÀ-ÖØ-Ý][\p{L}'’.-]+){1,3})/gu,
    /\b(?:welcome|introducing|joined by)\s+([A-ZÀ-ÖØ-Ý][\p{L}'’.-]+(?:\s+[A-ZÀ-ÖØ-Ý][\p{L}'’.-]+){1,3})/gu,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of window.matchAll(pattern)) {
      const candidate = normalizeSpeaker(match[1]);
      if (looksLikePerson(candidate)) found.push(candidate);
    }
  }
  return [...new Set(found)].slice(0, 3);
}

export function parseSpeakersFromTranscript(raw: string): SpeakerRecord {
  const speakers = transcriptIntroCandidates(raw);
  return speakers.length
    ? { speakers, source: "transcript_intro", confidence: 0.78 }
    : { speakers: [], source: "none", confidence: 0 };
}

function qHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) headers["api-key"] = QDRANT_KEY;
  return headers;
}

async function qRequest(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${QDRANT_URL}${path}`, {
    method: "POST",
    headers: qHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Qdrant ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function articleFiles(): string[] {
  if (!existsSync(ARTICLES_DIR)) return [];
  return readdirSync(ARTICLES_DIR)
    .filter((name) => name.endsWith(" :: www.youtube.com.md"))
    .map((name) => join(ARTICLES_DIR, name));
}

function articleForVideo(videoId: string, files: string[]): string | undefined {
  const byFilename = files.find((file) => file.split("/").pop()?.startsWith(`${videoId} ::`));
  if (byFilename) return byFilename;
  const marker = `watch?v=${videoId}`;
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    if (raw.includes(marker)) return file;
  }
  return undefined;
}

async function scrollPoints(): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | null = null;
  do {
    const body: Record<string, unknown> = {
      limit: 256,
      with_payload: ["source", "video_id"],
      with_vector: false,
    };
    if (offset !== null) body.offset = offset;
    const result = await qRequest(`/collections/${COLLECTION}/points/scroll`, body);
    points.push(...(result.result?.points || []));
    offset = result.result?.next_page_offset ?? null;
  } while (offset !== null);
  return points;
}

async function setPayload(points: Array<string | number>, record: SpeakerRecord): Promise<void> {
  const payload = {
    speakers: record.speakers,
    speaker: record.speakers[0] || null,
    speaker_extraction_source: record.source,
    speaker_confidence: record.confidence,
    speakers_version: VERSION,
  };
  for (let start = 0; start < points.length; start += 256) {
    await qRequest(`/collections/${COLLECTION}/points/payload?wait=true`, {
      payload,
      points: points.slice(start, start + 256),
    });
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const catalog = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as CatalogVideo[];
  const files = articleFiles();
  const enriched = catalog.map((video) => {
    const titleRecord = parseSpeakersFromTitle(video.title);
    const record = titleRecord.speakers.length
      ? titleRecord
      : parseSpeakersFromTranscript(articleForVideo(video.id, files) ? readFileSync(articleForVideo(video.id, files)!, "utf8") : "");
    return {
      ...video,
      speakers: record.speakers,
      speaker: record.speakers[0] || undefined,
      speaker_extraction_source: record.source,
      speaker_confidence: record.confidence,
      speakers_version: VERSION,
    };
  });

  const titleCount = enriched.filter((video) => video.speaker_extraction_source === "title").length;
  const transcriptCount = enriched.filter((video) => video.speaker_extraction_source === "transcript_intro").length;
  const coveredCount = enriched.filter((video) => video.speakers.length > 0).length;

  console.log(`Catalog videos: ${enriched.length}`);
  console.log(`Title-derived coverage: ${titleCount}`);
  console.log(`Transcript-intro coverage: ${transcriptCount}`);
  console.log(`Total speaker coverage: ${coveredCount}`);
  console.log(`Unclassified: ${enriched.length - coveredCount}`);

  if (dryRun) return;

  const tempFile = `${CATALOG_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(enriched, null, 2) + "\n");
  renameSync(tempFile, CATALOG_FILE);

  const points = await scrollPoints();
  const catalogById = new Map(enriched.map((video) => [video.id, video]));
  const groups = new Map<string, { record: SpeakerRecord; ids: Array<string | number> }>();
  let unmapped = 0;
  for (const point of points) {
    const payload = point.payload || {};
    const videoId = String(payload.video_id || payload.source || "");
    const video = catalogById.get(videoId);
    if (!video) {
      unmapped++;
      continue;
    }
    const record: SpeakerRecord = {
      speakers: video.speakers as string[],
      source: video.speaker_extraction_source as SpeakerSource,
      confidence: video.speaker_confidence as number,
    };
    const key = JSON.stringify(record);
    const group = groups.get(key) || { record, ids: [] };
    group.ids.push(point.id);
    groups.set(key, group);
  }

  for (const group of groups.values()) await setPayload(group.ids, group.record);

  console.log(`Qdrant points updated: ${points.length - unmapped}`);
  console.log(`Qdrant points unmapped: ${unmapped}`);
  console.log(`Payload groups written: ${groups.size}`);
}

if (import.meta.main) await main();
