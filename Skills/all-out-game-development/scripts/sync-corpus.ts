#!/usr/bin/env bun
import { createHash } from "node:crypto";
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

const DEFAULT_COLLECTION = "all-out-gamedev";
const DOC_INDEX = "https://docs.allout.game/llms.txt";
const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const DENSE_DIM = 1536;
const CHUNK_SIZE = 1800;
const CHUNK_OVERLAP = 220;
const SKILL_ROOT = "/home/workspace/Skills/all-out-game-development";

type Role = "director" | "engineer" | "art-ux" | "qa" | "shared";
type SourceType = "official_all_out" | "agency_agents" | "internal_playbook";

interface SourceDocument {
  title: string;
  url: string;
  source: string;
  sourceType: SourceType;
  roleTags: Role[];
  content: string;
  retrievedAt: string;
}

interface Chunk extends SourceDocument {
  section: string;
  chunkIndex: number;
  chunkTotal: number;
  chunk: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function help(): never {
  console.log("Usage: bun sync-corpus.ts [--collection name] [--dry-run]");
  process.exit(0);
}

function headers(): Record<string, string> {
  const value: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) value["api-key"] = QDRANT_KEY;
  return value;
}

async function qdrant(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Qdrant ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "All-Out-GameDev-Corpus/1.0" } });
  if (!response.ok) throw new Error(`Fetch ${url}: ${response.status}`);
  return response.text();
}

function normalize(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function officialRoles(url: string): Role[] {
  const roles = new Set<Role>(["shared"]);
  if (/getting-started|interactables|abilities|inventory|social-features|matchmaking|economy|monetization|publishing|uploading-metadata|feedback-ratings/.test(url)) roles.add("director");
  if (/scripting|using-cloud-build|entities|networking|player-model|random-math|assets-and-resources|purchasing|analytics|matchmaking|data-and-persistence|collaborating|protocol|project-layout|ui\//.test(url)) roles.add("engineer");
  if (/using-the-editor|assets-and-resources|sound-effects|spine|effects|camera|ui\//.test(url) || /improving-performance|uploading-metadata/.test(url)) roles.add("art-ux");
  if (/playtesting|publishing|handling-engine|improving-performance|creator-portal-web|monetization|data-and-persistence|terms-of-service/.test(url)) roles.add("qa");
  return [...roles];
}

async function fetchOfficialDocs(retrievedAt: string): Promise<SourceDocument[]> {
  const index = await fetchText(DOC_INDEX);
  const matches = [...index.matchAll(/^- \[([^\]]+)\]\((https:\/\/docs\.allout\.game\/[^)]+\.md)\)/gm)];
  const unique = new Map(matches.map((match) => [match[2], match[1]]));
  const entries = [...unique.entries()];
  const documents: SourceDocument[] = [];
  for (let start = 0; start < entries.length; start += 8) {
    const batch = entries.slice(start, start + 8);
    const fetched = await Promise.all(batch.map(async ([url, listedTitle]) => {
      const content = normalize(await fetchText(url));
      return {
        title: titleFromMarkdown(content, listedTitle),
        url,
        source: url.replace("https://docs.allout.game/", ""),
        sourceType: "official_all_out" as const,
        roleTags: officialRoles(url),
        content,
        retrievedAt,
      };
    }));
    documents.push(...fetched);
  }
  return documents;
}

async function htmlToPlain(url: string): Promise<string> {
  const html = await fetchText(url);
  const process = Bun.spawn(["pandoc", "-f", "html", "-t", "plain"], {
    stdin: new Blob([html]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(process.stdout).text();
  const error = await new Response(process.stderr).text();
  const code = await process.exited;
  if (code !== 0) throw new Error(`Pandoc failed for ${url}: ${error.trim()}`);
  return normalize(output);
}

async function fetchTerms(retrievedAt: string): Promise<SourceDocument> {
  const url = "https://allout.game/terms-of-service";
  const content = await htmlToPlain(url);
  return {
    title: "All Out Terms of Service",
    url,
    source: "terms-of-service",
    sourceType: "official_all_out",
    roleTags: ["director", "qa", "shared"],
    content,
    retrievedAt,
  };
}

const AGENCY_FILES: Array<[string, Role[]]> = [
  ["game-designer.md", ["director"]],
  ["economy-designer.md", ["director", "qa"]],
  ["level-designer.md", ["director", "art-ux"]],
  ["technical-artist.md", ["art-ux", "engineer"]],
  ["game-audio-engineer.md", ["art-ux"]],
];

async function fetchAgencyAgents(retrievedAt: string): Promise<SourceDocument[]> {
  return Promise.all(AGENCY_FILES.map(async ([file, roles]) => {
    const url = `https://raw.githubusercontent.com/msitarzewski/agency-agents/main/game-development/${file}`;
    const content = normalize(await fetchText(url));
    return {
      title: titleFromMarkdown(content, file.replace(/\.md$/, "")),
      url: `https://github.com/msitarzewski/agency-agents/blob/main/game-development/${file}`,
      source: `game-development/${file}`,
      sourceType: "agency_agents" as const,
      roleTags: [...new Set<Role>([...roles, "shared"])],
      content,
      retrievedAt,
    };
  }));
}

function localDocument(path: string, title: string, sourceType: SourceType, roleTags: Role[], retrievedAt: string): SourceDocument {
  return {
    title,
    url: `file://${path}`,
    source: path,
    sourceType,
    roleTags,
    content: normalize(readFileSync(path, "utf8")),
    retrievedAt,
  };
}

function localDocuments(retrievedAt: string): SourceDocument[] {
  return [
    localDocument(`${SKILL_ROOT}/references/game-director.md`, "Game Director Playbook", "internal_playbook", ["director"], retrievedAt),
    localDocument(`${SKILL_ROOT}/references/csl-engineer.md`, "CSL Engineer Playbook", "internal_playbook", ["engineer"], retrievedAt),
    localDocument(`${SKILL_ROOT}/references/technical-art-ux.md`, "Technical Art and UX Playbook", "internal_playbook", ["art-ux"], retrievedAt),
    localDocument(`${SKILL_ROOT}/references/qa-release.md`, "QA and Release Playbook", "internal_playbook", ["qa"], retrievedAt),
  ];
}

function sections(markdown: string): Array<{ title: string; content: string }> {
  const lines = markdown.split("\n");
  const output: Array<{ title: string; content: string }> = [];
  let title = "Overview";
  let body: string[] = [];
  const flush = () => {
    const content = normalize(body.join("\n"));
    if (content.length >= 40) output.push({ title, content });
  };
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flush();
      title = heading[1].trim();
      body = [line];
    } else {
      body.push(line);
    }
  }
  flush();
  return output.length ? output : [{ title: "Overview", content: markdown }];
}

function splitChunk(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  const advance = CHUNK_SIZE - CHUNK_OVERLAP;
  for (let index = 0; index < text.length; index += advance) chunks.push(text.slice(index, index + CHUNK_SIZE));
  return chunks;
}

function chunkDocuments(documents: SourceDocument[]): Chunk[] {
  const output: Chunk[] = [];
  for (const document of documents) {
    for (const section of sections(document.content)) {
      const chunks = splitChunk(`${document.title}\n${section.title}\n\n${section.content}`);
      chunks.forEach((chunk, chunkIndex) => output.push({
        ...document,
        section: section.title,
        chunkIndex,
        chunkTotal: chunks.length,
        chunk,
      }));
    }
  }
  return output;
}

async function embedChunks(chunks: Chunk[]): Promise<any[]> {
  const points: any[] = [];
  for (let start = 0; start < chunks.length; start += 8) {
    const batch = chunks.slice(start, start + 8);
    const embedded = await Promise.all(batch.map(async (item, offset) => {
      const result = await embeddings(item.chunk);
      if (result.embedding?.length !== DENSE_DIM) throw new Error(`Unexpected embedding size for ${item.url}`);
      const sparse = buildSparseVector(item.chunk);
      return {
        id: start + offset + 1,
        vector: {
          dense: result.embedding,
          sparse: { indices: sparse.indices, values: sparse.values },
        },
        payload: {
          collection: DEFAULT_COLLECTION,
          title: item.title,
          section: item.section,
          url: item.url,
          source: item.source,
          source_type: item.sourceType,
          role_tags: item.roleTags,
          retrieved_at: item.retrievedAt,
          content_sha256: createHash("sha256").update(item.chunk).digest("hex"),
          chunk_index: item.chunkIndex,
          chunk_total: item.chunkTotal,
          content: item.chunk,
        },
      };
    }));
    points.push(...embedded);
    process.stdout.write(`embedded ${Math.min(start + batch.length, chunks.length)}/${chunks.length}\r`);
  }
  process.stdout.write("\n");
  return points;
}

async function replaceCollection(collection: string, points: any[]): Promise<string | null> {
  const existing = await fetch(`${QDRANT_URL}/collections/${collection}`, { headers: headers() });
  let snapshot: string | null = null;
  if (existing.ok) {
    const created = await qdrant("POST", `/collections/${collection}/snapshots`);
    snapshot = created.result?.name || null;
    await qdrant("DELETE", `/collections/${collection}`);
  }
  await qdrant("PUT", `/collections/${collection}`, {
    vectors: { dense: { size: DENSE_DIM, distance: "Cosine" } },
    sparse_vectors: { sparse: { modifier: "idf" } },
    on_disk_payload: true,
  });
  for (let start = 0; start < points.length; start += 32) {
    await qdrant("PUT", `/collections/${collection}/points?wait=true`, { points: points.slice(start, start + 32) });
  }
  return snapshot;
}

async function main() {
  if (process.argv.includes("--help")) help();
  const collection = arg("collection") || DEFAULT_COLLECTION;
  const retrievedAt = new Date().toISOString();
  const documents = [
    ...await fetchOfficialDocs(retrievedAt),
    await fetchTerms(retrievedAt),
    ...await fetchAgencyAgents(retrievedAt),
    ...localDocuments(retrievedAt),
  ];
  const chunks = chunkDocuments(documents);
  const summary = {
    collection,
    documents: documents.length,
    chunks: chunks.length,
    source_types: Object.fromEntries([...new Set(documents.map((document) => document.sourceType))].map((type) => [type, documents.filter((document) => document.sourceType === type).length])),
    retrieved_at: retrievedAt,
  };
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ ...summary, dry_run: true }, null, 2));
    return;
  }
  const points = await embedChunks(chunks);
  const snapshot = await replaceCollection(collection, points);
  const info = await qdrant("GET", `/collections/${collection}`);
  console.log(JSON.stringify({
    ...summary,
    points: info.result?.points_count,
    status: info.result?.status,
    previous_snapshot: snapshot,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
