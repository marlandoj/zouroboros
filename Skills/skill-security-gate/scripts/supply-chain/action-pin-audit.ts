/**
 * action-pin-audit — pure core.
 *
 * Flags GitHub Action `uses:` references pinned to a MUTABLE tag/branch instead
 * of an immutable 40-hex commit SHA (the TJ-Actions re-point vector). Pure: the
 * parser is offline; SHA resolution (tag -> commit) is an INJECTED resolver so
 * tests never touch the network.
 */

import type { Finding } from './types.js';

export type ActionKind = 'remote' | 'local' | 'docker';

export interface ActionRef {
  file: string;
  line: number;
  /** The raw value after `uses:` with surrounding quotes stripped. */
  uses: string;
  owner?: string;
  repo?: string;
  /** The part after the last `@` (a tag, branch, or SHA). */
  ref?: string;
  kind: ActionKind;
  isSha: boolean;
}

/** A resolver that maps owner/repo@ref -> the immutable commit SHA, or null. */
export type ShaResolver = (owner: string, repo: string, ref: string) => string | null;

const SHA_RE = /^[0-9a-f]{40}$/i;

/** Parse every `uses:` reference out of a workflow YAML file. */
export function parseWorkflowUses(content: string, file: string): ActionRef[] {
  const refs: ActionRef[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Match `uses:` as a key (list item or mapping), ignore commented lines.
    const m = raw.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
    if (!m) continue;
    if (/^\s*#/.test(raw)) continue;
    let value = m[1].trim();
    // Strip a trailing inline comment and surrounding quotes.
    value = value.replace(/\s+#.*$/, '').trim();
    value = value.replace(/^["']|["']$/g, '').trim();
    if (!value) continue;

    const line = i + 1;

    if (value.startsWith('./') || value.startsWith('../')) {
      refs.push({ file, line, uses: value, kind: 'local', isSha: false });
      continue;
    }
    if (value.startsWith('docker://')) {
      refs.push({ file, line, uses: value, kind: 'docker', isSha: false });
      continue;
    }

    // Remote: owner/repo[/subpath]@ref
    const at = value.lastIndexOf('@');
    const ref = at >= 0 ? value.slice(at + 1) : undefined;
    const name = at >= 0 ? value.slice(0, at) : value;
    const parts = name.split('/');
    const owner = parts[0];
    const repo = parts[1];
    refs.push({
      file,
      line,
      uses: value,
      owner,
      repo,
      ref,
      kind: 'remote',
      isSha: ref ? SHA_RE.test(ref) : false,
    });
  }
  return refs;
}

/**
 * Audit parsed refs. A remote ref that is not a 40-hex SHA is CRITICAL (mutable).
 * Local (`./`) and docker refs are skipped (out of scope). When a resolver is
 * supplied, the suggested commit SHA is included in the remediation.
 */
export function auditActionPins(refs: ActionRef[], resolve?: ShaResolver): Finding[] {
  const findings: Finding[] = [];
  for (const r of refs) {
    if (r.kind !== 'remote') continue;
    if (r.isSha) continue;

    let suggested: string | null = null;
    if (resolve && r.owner && r.repo && r.ref) {
      try {
        suggested = resolve(r.owner, r.repo, r.ref);
      } catch {
        suggested = null;
      }
    }

    const refLabel = r.ref ?? '(no ref)';
    const pinHint = suggested
      ? `${r.owner}/${r.repo}@${suggested}  # ${refLabel}`
      : `${r.owner}/${r.repo}@<commit-sha>  # ${refLabel} (resolve the tag to its commit SHA)`;

    findings.push({
      target: `${r.file}:${r.line}`,
      category: 'action-pin',
      severity: 'critical',
      finding: `Action pinned to mutable ref "${refLabel}" instead of a commit SHA`,
      evidence: `${r.file}:${r.line} uses: ${r.uses}`,
      remediation: `Pin to the immutable commit SHA: uses: ${pinHint}`,
    });
  }
  return findings;
}
