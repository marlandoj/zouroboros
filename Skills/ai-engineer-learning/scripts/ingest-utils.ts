import { createHash } from "node:crypto";

export interface CatalogVideo {
  id: string;
  title: string;
  duration?: string;
  url: string;
  index: number;
  speaker?: string;
}

export type TranscriptStatus = "ok" | "unavailable" | "provider_blocked" | "error";

export interface TranscriptResult {
  status: TranscriptStatus;
  text?: string;
  errorType?: string;
  error?: string;
}

export function stablePointId(kind: "metadata" | "transcript", videoId: string, chunkIndex = 0): string {
  const hex = createHash("sha256")
    .update(`ai-engineer-videos:${kind}:${videoId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function mergeCatalog(fresh: CatalogVideo[], cached: CatalogVideo[]): CatalogVideo[] {
  const cachedById = new Map(cached.map((video) => [video.id, video]));
  return fresh.map((video, index) => ({
    ...cachedById.get(video.id),
    ...video,
    index: index + 1,
  }));
}

export function parseTranscriptProviderOutput(raw: string): TranscriptResult {
  try {
    const parsed = JSON.parse(raw) as TranscriptResult;
    if (["ok", "unavailable", "provider_blocked", "error"].includes(parsed.status)) return parsed;
  } catch {}
  return {
    status: "error",
    errorType: "InvalidProviderResponse",
    error: raw.trim().slice(0, 500) || "Transcript provider returned no structured response",
  };
}

export function extractFrontmatterUrl(raw: string): string {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
  return frontmatter.match(/^url:[ \t]*(https:\/\/\S+)[ \t]*$/m)?.[1] || "";
}

export function extractYoutubeUrl(raw: string): string {
  const frontmatterUrl = extractFrontmatterUrl(raw);
  if (frontmatterUrl) return frontmatterUrl;
  const watchId = raw.match(/https:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/)?.[1];
  if (watchId) return `https://www.youtube.com/watch?v=${watchId}`;
  const embedId = raw.match(/https:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/)?.[1];
  return embedId ? `https://www.youtube.com/watch?v=${embedId}` : "";
}
