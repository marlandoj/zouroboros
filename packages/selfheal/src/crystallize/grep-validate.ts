/**
 * grep-validate — verify every path/tool reference in a SKILL.md resolves
 * on disk.
 *
 * Per seed AC: SKILL.md may be LLM-drafted but every path/tool reference must
 * be grep-validated. Hallucinated `xyz.ts` becomes a mechanical-eval failure
 * before email.
 *
 * Reference forms recognized:
 *   - Backtick-quoted relative paths:  `packages/foo/bar.ts`
 *   - Backtick-quoted absolute paths:  `/home/workspace/...`
 *   - MCP tool refs:                   `mcp__zo__send_email_to_user`
 *
 * Tool refs (mcp__*) are validated against an allowlist supplied by the
 * caller — there is no filesystem source of truth for which MCP tools the
 * user has wired. v1 keeps the allowlist hard-coded inside the caller (CLI);
 * the validator just checks membership.
 */

import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';

export interface GrepValidateOptions {
  /** Project root used to resolve relative paths. */
  projectRoot: string;
  /** Allowlisted MCP tool names. References outside this set are reported. */
  knownMcpTools: ReadonlySet<string>;
}

export interface GrepValidateResult {
  ok: boolean;
  missingPaths: string[];
  unknownTools: string[];
}

const PATH_REF_REGEX = /`([^`\n]{1,200})`/g;
const MCP_TOOL_REGEX = /\bmcp__[a-z0-9_]+\b/gi;
// Skip backticked tokens that are obviously not paths or tool names.
const PATH_LIKE_REGEX = /^(\/|[a-z0-9_.@-]+\/[a-z0-9_./@-]+)/i;

export function validateReferences(
  skillMd: string,
  opts: GrepValidateOptions,
): GrepValidateResult {
  const missing = new Set<string>();
  const unknown = new Set<string>();

  // Path references (skip ones that don't look like paths).
  for (const m of skillMd.matchAll(PATH_REF_REGEX)) {
    const ref = m[1]!.trim();
    if (!PATH_LIKE_REGEX.test(ref)) continue;
    if (ref.startsWith('mcp__')) continue; // handled below
    const abs = isAbsolute(ref) ? ref : join(opts.projectRoot, ref);
    if (!existsSync(abs)) missing.add(ref);
  }

  // MCP tool references.
  for (const m of skillMd.matchAll(MCP_TOOL_REGEX)) {
    const tool = m[0]!;
    if (!opts.knownMcpTools.has(tool)) unknown.add(tool);
  }

  return {
    ok: missing.size === 0 && unknown.size === 0,
    missingPaths: [...missing],
    unknownTools: [...unknown],
  };
}
