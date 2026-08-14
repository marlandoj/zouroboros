/**
 * mcp-inventory + policy gate — pure core.
 *
 * Enumerates MCP servers from .mcp.json config objects, classifies each as
 * local-source (trusted) vs third-party (uvx/npx package or remote url), and
 * checks each against a checked-in policy file (allow / restrict / approve /
 * block). All pure: callers pass already-parsed JSON objects, so tests need no fs.
 */

import type { Finding } from './types.js';

export type ServerKind = 'local' | 'package' | 'remote-url' | 'binary';
export type ServerSource = 'local' | 'third-party';
export type PolicyVerdict = 'allow' | 'restrict' | 'approve' | 'block';

export interface McpServerEntry {
  id: string;
  configFile: string;
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  kind: ServerKind;
  source: ServerSource;
}

export interface McpPolicy {
  /** Per-server-id verdict. */
  policies: Record<string, PolicyVerdict>;
  /** Verdict for any server not listed (default: "approve"). */
  default?: PolicyVerdict;
}

const PACKAGE_RUNNERS = new Set(['uvx', 'npx', 'pipx', 'bunx', 'pip', 'pip3']);
const SCRIPT_RUNNERS = new Set(['bun', 'node', 'deno', 'python', 'python3', 'sh', 'bash', 'ts-node']);

function looksLocalPath(p: string | undefined): boolean {
  if (!p) return false;
  return p.startsWith('/') || p.startsWith('./') || p.startsWith('../') || p.includes('/');
}

/** Classify one server config into kind + trust source. */
export function classifyServer(
  id: string,
  configFile: string,
  cfg: { command?: string; args?: string[]; type?: string; url?: string },
): McpServerEntry {
  const base = { id, configFile, command: cfg.command, args: cfg.args, type: cfg.type, url: cfg.url };

  // Remote transport (http/sse with a URL) — always third-party.
  if (cfg.url || cfg.type === 'http' || cfg.type === 'sse') {
    return { ...base, kind: 'remote-url', source: 'third-party' };
  }

  const cmd = (cfg.command ?? '').trim();
  const cmdBase = cmd.split('/').pop() ?? cmd;

  // Package runners fetch from a registry -> third-party.
  if (PACKAGE_RUNNERS.has(cmdBase)) {
    return { ...base, kind: 'package', source: 'third-party' };
  }

  // Script runners executing a LOCAL file -> local/trusted.
  if (SCRIPT_RUNNERS.has(cmdBase)) {
    const firstFileArg = (cfg.args ?? []).find((a) => !a.startsWith('-'));
    if (looksLocalPath(firstFileArg)) {
      return { ...base, kind: 'local', source: 'local' };
    }
    // e.g. `bun x somepkg` or no local file -> treat as package/third-party.
    return { ...base, kind: 'package', source: 'third-party' };
  }

  // A direct path to an executable under the repo -> local/trusted.
  if (looksLocalPath(cmd)) {
    return { ...base, kind: 'local', source: 'local' };
  }

  // Bare binary name on PATH — unknown provenance, treat as third-party.
  return { ...base, kind: 'binary', source: 'third-party' };
}

/** Extract all server entries from one parsed .mcp.json object. */
export function inventoryConfig(configFile: string, parsed: unknown): McpServerEntry[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  // Support both the standard `mcpServers` key and the openclaw `servers` key.
  const servers = (obj.mcpServers ?? obj.servers) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return [];

  const entries: McpServerEntry[] = [];
  for (const [id, raw] of Object.entries(servers)) {
    const cfg = (raw && typeof raw === 'object' ? raw : {}) as {
      command?: string;
      args?: string[];
      type?: string;
      url?: string;
    };
    entries.push(classifyServer(id, configFile, cfg));
  }
  return entries;
}

/** Look up the policy verdict for a server (falls back to policy.default or "approve"). */
export function verdictFor(entry: McpServerEntry, policy: McpPolicy): PolicyVerdict {
  return policy.policies[entry.id] ?? policy.default ?? 'approve';
}

/**
 * Turn the inventory + policy into findings.
 *   block    -> critical
 *   approve  -> info   (unlisted/needs operator decision)
 *   restrict -> warning
 *   allow    -> no finding
 */
export function auditMcpPolicy(entries: McpServerEntry[], policy: McpPolicy): Finding[] {
  const findings: Finding[] = [];
  for (const e of entries) {
    const verdict = verdictFor(e, policy);
    const cls = `${e.kind}/${e.source}`;
    const where = `${e.configFile} [${cls}]`;

    if (verdict === 'allow') continue;

    if (verdict === 'block') {
      findings.push({
        target: e.id,
        category: 'mcp-policy',
        severity: 'critical',
        finding: `MCP server "${e.id}" is BLOCKED by policy`,
        evidence: where,
        remediation: `Remove this server from ${e.configFile} or change its policy from "block".`,
      });
    } else if (verdict === 'restrict') {
      findings.push({
        target: e.id,
        category: 'mcp-policy',
        severity: 'warning',
        finding: `MCP server "${e.id}" is RESTRICTED by policy`,
        evidence: where,
        remediation: `Confirm the restricted usage of "${e.id}" is acceptable in this context.`,
      });
    } else {
      // approve (incl. unlisted default)
      const unlisted = !(e.id in policy.policies);
      findings.push({
        target: e.id,
        category: 'mcp-policy',
        severity: 'info',
        finding: unlisted
          ? `MCP server "${e.id}" is not in the policy file (defaults to "approve")`
          : `MCP server "${e.id}" needs operator approval`,
        evidence: where,
        remediation: `Add "${e.id}" to mcp-policy.json with an explicit allow/restrict/block decision.`,
      });
    }
  }
  return findings;
}
