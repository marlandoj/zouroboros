#!/usr/bin/env bun
/**
 * AI Engineer Learning — Batch transcript processor.
 *
 * Reads saved YouTube transcript markdown files from the Articles directory,
 * extracts transcripts, chunks, embeds, and upserts to Qdrant.
 *
 * Usage:
 *   bun process-transcripts.ts [--batch <n>] [--limit <n>]
 *
 *   --batch N     Process only N unprocessed files (default: all)
 *   --limit N     Stop after N total chunks indexed
 *   --dry-run     Parse only, don't embed or upsert
 *   --cohort-manifest=<path> --rebuild
 *                 Rebuild only canonical Article IDs in a preflight manifest
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { extractYoutubeUrl, stablePointId } from "./ingest-utils";

// Self-heal OPENAI key from /root/.zo_secrets when invoked under `env -i`.
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

const { embeddings: mcEmbeddings } = await import(
  "/home/workspace/Skills/zo-memory-system/scripts/model-client.ts"
);

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = "ai-engineer-videos";
const VECTOR_SIZE = 1536;
const CHUNK_CHARS = 2000;
const CHUNK_OVERLAP = 300;

const ARTICLES_DIR = "/home/workspace/Articles";
const STATE_FILE = "/home/workspace/Projects/ai-engineer-learning/processed.json";
const PENDING_FILE = "/home/workspace/Projects/ai-engineer-learning/pending-transcripts.json";

interface ProcessedState {
  processed: Record<string, { hash: string; chunks: number; timestamp: string }>;
}

interface CohortManifestItem {
  video_id: string;
  artifact_state: string;
  article_path?: string | null;
  article_hash?: string | null;
}

interface ProcessorOptions {
  batchSize: number;
  dryRun: boolean;
  limit: number;
  rebuild: boolean;
  cohortManifest?: string;
}

function loadState(): ProcessedState {
  if (!existsSync(STATE_FILE)) return { processed: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { processed: {} };
  }
}

function saveState(state: ProcessedState) {
  mkdirSync(join(STATE_FILE, ".."), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

// evidence-readiness/v1 requires a full 64-hex-char digest (SHA256_RE); the
// change-detection sha256() above is intentionally truncated to 16 chars and
// must not be reused or extended for this purpose (ZOU-1291).
function sha256Full(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Bumped because this is a contract-relevant payload change (ZOU-1291 adds
// has_transcript/article_path/source_hash/processor_version to the upsert).
export const PROCESSOR_VERSION = "process-transcripts/v2";

export function parseProcessorOptions(argv: string[]): ProcessorOptions {
  const batchArg = argv.find((arg) => arg.startsWith("--batch="));
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const manifestArg = argv.find((arg) => arg.startsWith("--cohort-manifest="));
  const options: ProcessorOptions = {
    batchSize: batchArg ? Number.parseInt(batchArg.split("=")[1], 10) : Infinity,
    dryRun: argv.includes("--dry-run"),
    limit: limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : Infinity,
    rebuild: argv.includes("--rebuild"),
    cohortManifest: manifestArg?.slice("--cohort-manifest=".length),
  };
  if (options.rebuild !== Boolean(options.cohortManifest)) {
    throw new Error("--rebuild and --cohort-manifest=<path> must be supplied together");
  }
  if (options.batchSize !== Infinity && (!Number.isInteger(options.batchSize) || options.batchSize < 1)) {
    throw new Error("--batch must be a positive integer");
  }
  if (options.limit !== Infinity && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return options;
}

export function loadCohortManifest(path: string): Map<string, CohortManifestItem> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { items?: CohortManifestItem[] };
  if (!Array.isArray(parsed.items)) throw new Error("Cohort manifest must contain an items array");
  const selected = parsed.items.filter((item) => item.artifact_state === "canonical_article");
  if (selected.length === 0) throw new Error("Cohort manifest contains no canonical Articles");
  const result = new Map<string, CohortManifestItem>();
  for (const item of selected) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.video_id)) {
      throw new Error(`Invalid cohort video ID: ${item.video_id}`);
    }
    if (result.has(item.video_id)) throw new Error(`Duplicate cohort video ID: ${item.video_id}`);
    result.set(item.video_id, item);
  }
  return result;
}

export function shouldProcess(
  videoId: string,
  fileHash: string,
  state: ProcessedState,
  forceRebuildIds: ReadonlySet<string>,
): boolean {
  return forceRebuildIds.has(videoId) || state.processed[videoId]?.hash !== fileHash;
}

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}

async function qReq(method: string, path: string, body?: any) {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: qHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Qdrant ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function ensureCollection() {
  const exists = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { headers: qHeaders() });
  if (exists.ok) {
    console.log(`  collection '${COLLECTION}' exists, reusing.`);
    return;
  }
  await qReq("PUT", `/collections/${COLLECTION}`, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    on_disk_payload: true,
  });
  console.log(`  collection '${COLLECTION}' created.`);
}

function findTranscriptFiles(): string[] {
  if (!existsSync(ARTICLES_DIR)) return [];
  const files = readdirSync(ARTICLES_DIR)
    .filter((f) => f.endsWith(" :: www.youtube.com.md"))
    .map((f) => join(ARTICLES_DIR, f));
  return files;
}

interface VideoData {
  title: string;
  url: string;
  speaker?: string;
  transcript: string;
  fileHash: string;
  sourceHashFull: string;
}

export function parseTranscriptFile(path: string): VideoData | null {
  const raw = readFileSync(path, "utf8");

  // Extract frontmatter URL
  const url = extractYoutubeUrl(raw);

  // Extract title from H1
  const titleMatch = raw.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : basename(path);

  // Extract speaker from italic line after title
  const speakerMatch = raw.match(/^\*([^\*]+)\*$/m);
  const speaker = speakerMatch ? speakerMatch[1].trim() : undefined;

  // Check for "Transcript not available"
  if (raw.includes("*Transcript not available*")) {
    return null;
  }

  // Extract transcript text: everything between "## Transcript" and the end
  const transcriptStart = raw.indexOf("## Transcript");
  if (transcriptStart < 0) return null;

  const transcriptSection = raw.slice(transcriptStart + "## Transcript".length);

  // Parse timestamp sections
  const sections: { time: string; text: string }[] = [];
  const timestampRe = /^\[(\d+:\d+)\]\(https:\/\/youtube\.com\/watch\?[^)]+\)/gm;
  let m;
  while ((m = timestampRe.exec(transcriptSection)) !== null) {
    const time = m[1];
    const startIdx = m.index + m[0].length;
    // Find next timestamp or end of section
    const nextMatch = timestampRe.exec(transcriptSection);
    const endIdx = nextMatch ? nextMatch.index : transcriptSection.length;
    timestampRe.lastIndex = startIdx; // Reset for next iteration

    const text = transcriptSection
      .slice(startIdx, endIdx)
      .replace(/\n+/g, " ")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "")
      .trim();

    if (text.length > 10) {
      sections.push({ time, text });
    }
  }

  // Also try parsing by "---" delimiters (separator between timestamp blocks)
  if (sections.length === 0) {
    const blocks = transcriptSection.split("\n\n---\n\n");
    for (const block of blocks) {
      const timeMatch = block.match(/^\[(\d+:\d+)\]/);
      if (timeMatch) {
        const time = timeMatch[1];
        const text = block.replace(/^\[\d+:\d+\][^\n]*\n*/, "").replace(/\n+/g, " ").trim();
        if (text.length > 10) {
          sections.push({ time, text });
        }
      }
    }
  }

  // Combine all transcript text with timestamps
  const transcript = sections
    .map((s) => `[${s.time}] ${s.text}`)
    .join("\n\n");

  if (transcript.length < 200) return null;

  return {
    title,
    url,
    speaker,
    transcript,
    fileHash: sha256(raw),
    sourceHashFull: sha256Full(raw),
  };
}

function chunkText(text: string, chars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chars) return [text];
  const advance = Math.max(1, chars - overlap);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += advance) {
    chunks.push(text.slice(i, i + chars));
  }
  return chunks;
}

const CTRL_RE = new RegExp(
  "[" +
    "\\u0000-\\u0008" +
    "\\u000B\\u000C" +
    "\\u000E-\\u001F" +
    "\\uFEFF" +
  "]",
  "g",
);

function sanitize(s: string): string {
  let out = s.replace(CTRL_RE, "");
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return out;
}

// evidence-readiness/v1 lineage fields (ZOU-1291): a chunk point must declare
// has_transcript plus the source-lineage triple so readinessForHit can derive
// transcript_staged instead of failing closed on transcript_available_without_article_path.
export function buildChunkPayload(params: {
  videoId: string;
  title: string;
  url: string;
  speaker?: string;
  chunkIndex: number;
  chunkTotal: number;
  content: string;
  articlePath: string;
  sourceHash: string;
}): Record<string, unknown> {
  return {
    collection: COLLECTION,
    video_id: params.videoId,
    title: params.title,
    url: params.url,
    speaker: params.speaker || null,
    chunk_index: params.chunkIndex,
    chunk_total: params.chunkTotal,
    content: params.content,
    has_transcript: true,
    article_path: params.articlePath,
    source_hash: params.sourceHash,
    processor_version: PROCESSOR_VERSION,
  };
}

async function upsert(points: { id: string | number; vector: number[]; payload: any }[]) {
  if (points.length === 0) return;
  const cleaned = points.map((p) => ({
    ...p,
    payload: Object.fromEntries(
      Object.entries(p.payload).map(([k, v]) => [
        k,
        typeof v === "string" ? sanitize(v) : v,
      ])
    ),
  }));

  try {
    await qReq("PUT", `/collections/${COLLECTION}/points?wait=true`, { points: cleaned });
  } catch {
    let kept = 0;
    for (const p of cleaned) {
      try {
        await qReq("PUT", `/collections/${COLLECTION}/points?wait=true`, { points: [p] });
        kept++;
      } catch (err) {
        console.error(`  drop id=${p.id}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    if (kept < cleaned.length) throw new Error(`Only ${kept}/${cleaned.length} points were saved`);
  }
}

async function deleteMetadataPoint(videoId: string) {
  await qReq("POST", `/collections/${COLLECTION}/points/delete?wait=true`, {
    filter: {
      must: [
        { key: "video_id", match: { value: videoId } },
        { key: "has_transcript", match: { value: false } },
      ],
    },
  });
}

function removePending(videoId: string) {
  if (!existsSync(PENDING_FILE)) return;
  try {
    const pending = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
    if (!Array.isArray(pending.videos)) return;
    pending.videos = pending.videos.filter((video: { id?: string }) => video.id !== videoId);
    pending.updated_at = new Date().toISOString();
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  } catch {}
}

async function processFiles(
  files: string[],
  dryRun: boolean,
  forceRebuildIds: ReadonlySet<string> = new Set(),
): Promise<{ processed: number; skipped: number; chunks: number }> {
  const state = loadState();
  let totalChunks = 0;
  let processed = 0;
  let skipped = 0;

  for (const file of files) {
    const data = parseTranscriptFile(file);
    if (!data) {
      console.log(`  SKIP (no transcript): ${basename(file)}`);
      skipped++;
      continue;
    }

    const vidId = data.url.match(/v=([a-zA-Z0-9_-]+)/)?.[1] || basename(file);

    // Skip if already processed with same hash
    if (!shouldProcess(vidId, data.fileHash, state, forceRebuildIds)) {
      console.log(`  SKIP (cached): ${data.title}`);
      skipped++;
      continue;
    }

    console.log(`  PROCESS: ${data.title}`);

    const chunks = chunkText(data.transcript);
    console.log(`    → ${chunks.length} chunks`);

    if (dryRun) {
      processed++;
      totalChunks += chunks.length;
      continue;
    }

    const points: { id: string | number; vector: number[]; payload: any }[] = [];
    let embeddedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const result = await mcEmbeddings(chunks[i]);
        if (!result.embedding?.length) throw new Error("empty embedding");
        points.push({
          id: stablePointId("transcript", vidId, i),
          vector: result.embedding,
          payload: buildChunkPayload({
            videoId: vidId,
            title: data.title,
            url: data.url,
            speaker: data.speaker,
            chunkIndex: i,
            chunkTotal: chunks.length,
            content: chunks[i],
            articlePath: `Articles/${basename(file)}`,
            sourceHash: data.sourceHashFull,
          }),
        });
        totalChunks++;
        embeddedChunks++;
        if (points.length >= 16) {
          await upsert(points);
          points.length = 0;
          process.stdout.write(".");
        }
      } catch (e) {
        console.error(`\n    embed error chunk ${i}: ${(e as Error).message}`);
      }
    }

    if (points.length) await upsert(points);
    if (embeddedChunks !== chunks.length) {
      throw new Error(`Transcript ${vidId} embedded ${embeddedChunks}/${chunks.length} chunks`);
    }
    await deleteMetadataPoint(vidId);

    state.processed[vidId] = {
      hash: data.fileHash,
      chunks: chunks.length,
      timestamp: new Date().toISOString(),
    };
    saveState(state);
    removePending(vidId);
    processed++;
    console.log(`    ✓ done`);
  }

  return { processed, skipped, chunks: totalChunks };
}

async function main() {
  const options = parseProcessorOptions(process.argv.slice(2));

  console.log(`AI Engineer Learning — Transcript Processor`);
  console.log(`  collection: ${COLLECTION}`);
  console.log(`  Qdrant: ${QDRANT_URL}`);
  console.log(`  dry-run: ${options.dryRun}`);
  console.log(`  batch: ${options.batchSize === Infinity ? "all" : options.batchSize}`);
  console.log(`  rebuild: ${options.rebuild}`);
  console.log("");

  const files = findTranscriptFiles();
  const seenVideoIds = new Set<string>();
  const uniqueFiles = files
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .filter((file) => {
      const raw = readFileSync(file, "utf8");
      const videoId = raw.match(/v=([a-zA-Z0-9_-]+)/)?.[1] || basename(file);
      if (seenVideoIds.has(videoId)) return false;
      seenVideoIds.add(videoId);
      return true;
    });
  console.log(`Found ${files.length} transcript files (${uniqueFiles.length} unique videos) in ${ARTICLES_DIR}`);

  const state = loadState();
  const forceRebuildIds = options.cohortManifest
    ? loadCohortManifest(options.cohortManifest)
    : new Map<string, CohortManifestItem>();
  const forceRebuildSet = new Set(forceRebuildIds.keys());
  const filesById = new Map<string, string>();
  for (const file of uniqueFiles) {
    const raw = readFileSync(file, "utf8");
    const videoId = raw.match(/v=([a-zA-Z0-9_-]+)/)?.[1] || basename(file);
    filesById.set(videoId, file);
  }
  const candidateFiles = options.cohortManifest
    ? [...forceRebuildIds].map(([videoId, item]) => {
        const file = item.article_path || filesById.get(videoId);
        if (!file) throw new Error(`No Article found for cohort video ${videoId}`);
        const real = realpathSync(file);
        if (!real.startsWith(`${ARTICLES_DIR}/`)) {
          throw new Error(`Cohort Article is outside ${ARTICLES_DIR}: ${videoId}`);
        }
        const data = parseTranscriptFile(real);
        if (!data) throw new Error(`Article contract failed for cohort video ${videoId}`);
        const parsedVideoId = data.url.match(/v=([a-zA-Z0-9_-]+)/)?.[1];
        if (parsedVideoId !== videoId) throw new Error(`Article video ID mismatch for ${videoId}`);
        if (item.article_hash && item.article_hash !== data.fileHash) {
          throw new Error(`Article changed after preflight for cohort video ${videoId}`);
        }
        return real;
      })
    : uniqueFiles;

  const unprocessed = candidateFiles.filter((f) => {
    const raw = readFileSync(f, "utf8");
    const vidId = raw.match(/v=([a-zA-Z0-9_-]+)/)?.[1] || basename(f);
    const hash = sha256(raw);
    return shouldProcess(vidId, hash, state, forceRebuildSet);
  });

  console.log(`${unprocessed.length} unprocessed files`);

  const toProcess = unprocessed.slice(0, options.batchSize);
  console.log(`Processing ${toProcess.length} files...\n`);

  if (!options.dryRun) await ensureCollection();

  const start = Date.now();
  const result = await processFiles(toProcess, options.dryRun, forceRebuildSet);

  console.log(`\n\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  Processed: ${result.processed}`);
  console.log(`  Skipped:   ${result.skipped}`);
  console.log(`  Chunks:    ${result.chunks}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
