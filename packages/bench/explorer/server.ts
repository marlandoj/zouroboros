#!/usr/bin/env bun
/**
 * ZouroBench Results Explorer — read-only API server (ZBRE-003 / ZOU-831).
 *
 * Thin Bun.serve wrapper around the pure handler. Reads only from the
 * configured roots under `packages/bench/data`; serves GET only.
 */

import { resolve } from "node:path";
import { createArtifactStore } from "./artifact-store";
import { handleExplorerRequest } from "./api";

export const DEFAULT_DATA_ROOT = resolve(import.meta.dir, "..", "data");
export const DEFAULT_PORT = 7841;

export function startExplorerServer(options?: { port?: number; dataRoot?: string }) {
  const store = createArtifactStore({ dataRoot: options?.dataRoot ?? DEFAULT_DATA_ROOT });
  return Bun.serve({
    port: options?.port ?? DEFAULT_PORT,
    fetch: (req) => handleExplorerRequest(store, req),
  });
}

if (import.meta.main) {
  const port = Number(process.env.EXPLORER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`EXPLORER_PORT is not a valid port: ${process.env.EXPLORER_PORT}`);
    process.exit(1);
  }
  const server = startExplorerServer({ port, dataRoot: process.env.EXPLORER_DATA_ROOT });
  console.log(`ZouroBench Results Explorer API (read-only) on http://localhost:${server.port}/api/health`);
}
