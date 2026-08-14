#!/usr/bin/env bun
/**
 * ZouroBench Results Explorer — private production server (ZBRE-012 / ZOU-840).
 *
 * A single persistent process that puts the validated explorer in reach of its
 * operator without exposing evidence publicly. It composes two surfaces that
 * were built independently and never previously wired across a process
 * boundary:
 *
 *   - the built static SPA (`Sites/zourobench-results-explorer/dist`), served
 *     with history fallback so all six routes are directly addressable, and
 *   - the ZBRE-003 read-only artifact API, served same-origin under `/api/*`
 *     against the LIVE artifact root (`packages/bench/data`) — so live run
 *     discovery works from the production service, not only the dev process.
 *
 * The whole surface is read-only: `/api/*` already rejects mutations, and the
 * static side answers only GET/HEAD. The listener binds to loopback by default
 * so the deployment is private.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createArtifactStore, type ArtifactStore } from "./artifact-store";
import { handleExplorerRequest } from "./api";
import { DEFAULT_DATA_ROOT } from "./server";

/** Loopback-only by default: the explorer is private, never public. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PROD_PORT = 7842;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Built SPA output, resolved relative to the repository layout by default. */
export const DEFAULT_SITE_DIST = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "Sites",
  "zourobench-results-explorer",
  "dist",
);

/** Client-side routes the SPA owns; each falls back to `index.html`. */
export const SPA_ROUTES: readonly string[] = [
  "runs",
  "questions",
  "reliability",
  "compare",
  "consensus",
  "operations",
];

const IMMUTABLE_PREFIX = "/assets/";
const INDEX_FILE = "index.html";

export interface ProductionServerConfig {
  /** Absolute path to the built SPA directory. */
  siteDist: string;
  /** Absolute path to the live artifact data root. */
  dataRoot: string;
}

/**
 * Resolve a request path to a concrete file inside `distRoot`, or `null` if it
 * escapes the root or does not resolve to a regular file. No path is ever built
 * from request input without this containment check — the same discipline the
 * artifact store applies to data files.
 */
export function resolveStaticFile(distRoot: string, pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, "");
  if (rel.length === 0) return safeFile(distRoot, resolve(distRoot, INDEX_FILE));
  const candidate = resolve(distRoot, rel);
  if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) return null;
  return safeFile(distRoot, candidate);
}

function safeFile(distRoot: string, candidate: string): string | null {
  if (!existsSync(candidate)) return null;
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  // A resolved symlink must still live inside the dist root.
  if (real !== distRoot && !real.startsWith(distRoot + sep)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function cacheHeadersFor(pathname: string): Record<string, string> {
  // Vite emits content-hashed asset filenames — safe to cache immutably.
  if (pathname.startsWith(IMMUTABLE_PREFIX)) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }
  // The shell and every route fallback must always re-validate so a redeploy
  // is picked up immediately.
  return { "Cache-Control": "no-cache" };
}

function staticResponse(file: string, cacheHeaders: Record<string, string>, method: string): Response {
  const body = Bun.file(file);
  const headers = { ...cacheHeaders, "X-Content-Type-Options": "nosniff" };
  if (method === "HEAD") {
    return new Response(null, { headers: { ...headers, "Content-Type": body.type } });
  }
  return new Response(body, { headers });
}

/**
 * Pure request handler for the combined production surface. `/api/*` is handed
 * to the read-only artifact API; everything else is static SPA serving with a
 * history fallback to `index.html`. Only GET/HEAD are answered.
 */
export function handleProductionRequest(
  store: ArtifactStore,
  distRoot: string,
  req: Request,
): Response {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return handleExplorerRequest(store, req);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const direct = resolveStaticFile(distRoot, pathname);
  if (direct) {
    return staticResponse(direct, cacheHeadersFor(pathname), req.method);
  }

  // A missing asset under the hashed-asset prefix is a genuine 404 — never fall
  // back to the shell for it, or a stale bundle reference would 200 silently.
  if (pathname.startsWith(IMMUTABLE_PREFIX)) {
    return new Response("not found", { status: 404 });
  }

  // History fallback: any other GET/HEAD renders the SPA shell so all six
  // routes are directly addressable in the production build.
  const shell = safeFile(distRoot, resolve(distRoot, INDEX_FILE));
  if (!shell) {
    return new Response("explorer build missing: run `bun run build` in the Site", { status: 503 });
  }
  return staticResponse(shell, cacheHeadersFor("/"), req.method);
}

export function startProductionServer(options?: {
  port?: number;
  host?: string;
  dataRoot?: string;
  siteDist?: string;
}) {
  const dataRoot = options?.dataRoot ?? DEFAULT_DATA_ROOT;
  const siteDist = options?.siteDist ?? DEFAULT_SITE_DIST;
  const distRoot = resolveDistRoot(siteDist);
  const store = createArtifactStore({ dataRoot });
  return Bun.serve({
    port: options?.port ?? DEFAULT_PROD_PORT,
    hostname: options?.host ?? DEFAULT_HOST,
    fetch: (req) => handleProductionRequest(store, distRoot, req),
  });
}

/**
 * Canonicalize the dist root once at startup. If the build is missing we still
 * start (health and the API remain available); route requests then answer 503
 * with an actionable message rather than crashing the process.
 */
function resolveDistRoot(siteDist: string): string {
  try {
    return realpathSync(siteDist);
  } catch {
    return resolve(siteDist);
  }
}

if (import.meta.main) {
  const port = Number(process.env.EXPLORER_PROD_PORT ?? DEFAULT_PROD_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`EXPLORER_PROD_PORT is not a valid port: ${process.env.EXPLORER_PROD_PORT}`);
    process.exit(1);
  }
  const host = process.env.EXPLORER_HOST ?? DEFAULT_HOST;
  // Private by construction: a non-loopback bind exposes benchmark evidence and
  // must be an explicit, deliberate opt-in — never a silent config drift.
  if (!isLoopbackHost(host) && process.env.EXPLORER_ALLOW_PUBLIC_BIND !== "1") {
    console.error(
      `refusing to bind non-loopback host ${host}: the explorer is private. ` +
        `Set EXPLORER_ALLOW_PUBLIC_BIND=1 only if you have a deliberate, access-controlled reason.`,
    );
    process.exit(1);
  }
  const dataRoot = process.env.EXPLORER_DATA_ROOT ?? DEFAULT_DATA_ROOT;
  const siteDist = process.env.EXPLORER_SITE_DIST ?? DEFAULT_SITE_DIST;

  const distRoot = resolveDistRoot(siteDist);
  if (!existsSync(resolve(distRoot, INDEX_FILE))) {
    console.error(
      `warning: SPA build not found at ${distRoot}; route requests will answer 503 until \`bun run build\` runs in the Site`,
    );
  }
  // Confirm the live data root is readable before advertising the service.
  let dataRootIsDir = false;
  try {
    dataRootIsDir = statSync(dataRoot).isDirectory();
  } catch {
    dataRootIsDir = false;
  }
  if (!dataRootIsDir) {
    console.error(`EXPLORER_DATA_ROOT is not a readable directory: ${dataRoot}`);
    process.exit(1);
  }

  const server = startProductionServer({ port, host, dataRoot, siteDist });
  console.log(
    `ZouroBench Results Explorer (private) on http://${server.hostname}:${server.port}/  ` +
      `[api: /api/health, data: ${dataRoot}]`,
  );
}
