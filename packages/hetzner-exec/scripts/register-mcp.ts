#!/usr/bin/env bun
/**
 * Emits the Zo-compatible `.mcp.json` entry for the hetzner-exec MCP server.
 *
 * Registers hetzner-exec via the stdio↔HTTP bridge (`mcp-stdio-bridge.ts`) so it
 * works with Zo's existing `command`-based MCP registration. Writes the manifest
 * to `mcp-registration.json` next to the package and prints the entry + merge
 * instructions.
 *
 * Shadow-safe: does NOT modify the live `~/.mcp.json`. The operator merges the
 * emitted entry once the Hetzner box is live and reachable at HETZNER_EXEC_PUBLIC_URL.
 *
 * Env:
 *   HETZNER_EXEC_PUBLIC_URL  Reachable base URL of the live server (e.g. https://box.example.com)
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "mcp-stdio-bridge.ts");
const PKG_ROOT = dirname(HERE);
const OUT = join(PKG_ROOT, "mcp-registration.json");

const baseUrl = (process.env.HETZNER_EXEC_PUBLIC_URL ?? "https://box.example.com").replace(/\/$/, "");

const manifest = {
  mcpServers: {
    "hetzner-exec": {
      command: "bun",
      args: [BRIDGE],
      env: {
        HETZNER_EXEC_URL: baseUrl,
        HETZNER_EXEC_TOKEN: "<set-to-HETZNER_EXEC_TOKEN-secret>",
      },
    },
  },
};

const json = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(OUT, json, "utf8");

console.log(json);
console.log("# ────────────────────────────────────────────────────────────");
console.log(`# Manifest written to: ${OUT}`);
console.log("# To register in Zo:");
console.log("#   1. Replace <set-to-HETZNER_EXEC_TOKEN-secret> with the real");
console.log("#      HETZNER_EXEC_TOKEN value (the same secret the server runs with).");
console.log("#   2. Merge the \"hetzner-exec\" key above into ~/.mcp.json");
console.log("#      (or Settings → Integrations, if Zo exposes MCP via UI).");
console.log("#   3. Restart Zo so the MCP client picks up the new server.");
console.log("#");
console.log(`# Shadow phase: apply this AFTER the box is live at ${baseUrl}`);
console.log("# ────────────────────────────────────────────────────────────");
