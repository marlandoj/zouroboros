// CLI entrypoint for the hetzner-exec MCP server.
//
//   bun src/main.ts                 # listen on configured port (default 6666)
//   HETZNER_EXEC_TOKEN=secret bun src/main.ts
//
// Refuses to start without HETZNER_EXEC_TOKEN (fail-closed): an unauthenticated
// remote command-execution server is an open shell.

import { loadConfig } from "./config";
import { createServer, type AppHandle } from "./server";

let handle: AppHandle | undefined;

try {
  const config = loadConfig();
  if (!config.authToken) {
    console.error("[hetzner-exec] refusing to start: HETZNER_EXEC_TOKEN is required (fail-closed).");
    process.exit(1);
  }
  handle = createServer(config);
  handle.server.listen(config.port, () => {
    console.log(
      `[hetzner-exec] listening on :${config.port} (sandbox=${config.sandboxProvider})`,
    );
  });
} catch (e) {
  console.error(`[hetzner-exec] startup error: ${(e as Error).message}`);
  process.exit(1);
}

function shutdown(sig: string): void {
  console.log(`[hetzner-exec] received ${sig}, shutting down...`);
  handle?.close().finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
