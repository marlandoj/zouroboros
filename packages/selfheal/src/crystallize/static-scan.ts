/**
 * Mutation-resistant static scan for malicious patterns in candidate output.
 *
 * Per seed AC + Sec Eng F1–F6: every drafted file (SKILL.md + script stubs) is
 * scanned before write; any match → `eval_status='mechanical_fail'`, payload
 * carries the matched pattern_id, NO email is sent.
 *
 * Mutations covered (see AC-Q4 + FX-05/06/07):
 *   - whitespace variants (extra spaces/tabs/newlines between tokens)
 *   - case variants
 *   - unicode-fold variants (NFKC normalization before match)
 */

export interface StaticScanFinding {
  matched: string | null; // pattern id, or null on clean
  line: number; // 1-indexed; 0 if file-level
  excerpt?: string;
}

export interface PatternRule {
  id: string;
  description: string;
  /** Whitespace-tolerant, case-insensitive regex applied to NFKC-normalized text. */
  regex: RegExp;
}

export const MALICIOUS_PATTERNS: PatternRule[] = [
  {
    id: 'rm_rf',
    description: 'rm -rf-style recursive deletion (combined short flags)',
    regex: /\brm\s+(?=-[a-z]*r)(?=-[a-z]*f)-[a-z]+\s+\/?/i,
  },
  {
    id: 'rm_rf_separated',
    description: 'rm with space-separated -r and -f short flags in either order',
    regex: /\brm\s+-[rfRF]\s+-[rfRF]\s+\/?/i,
  },
  {
    id: 'rm_rf_long',
    description: 'rm with long-form --recursive --force flags',
    regex: /\brm\s+(--recursive\s+--force|--force\s+--recursive)\b/i,
  },
  {
    id: 'curl_pipe_sh',
    description: 'curl|sh / curl|bash remote-code-exec',
    regex: /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/i,
  },
  {
    id: 'wget_pipe_sh',
    description: 'wget piped into shell',
    regex: /\bwget\b[^\n|]*\|\s*(ba)?sh\b/i,
  },
  {
    id: 'eval_call',
    description: 'eval() of arbitrary string',
    regex: /\beval\s*\(/i,
  },
  {
    id: 'os_system',
    description: 'os.system shell call',
    regex: /\bos\.system\s*\(/i,
  },
  {
    id: 'subprocess_shell_true',
    description: 'subprocess with shell=True',
    regex: /\bsubprocess\b[\s\S]{0,80}?shell\s*=\s*true/i,
  },
  {
    id: 'redirect_dev',
    description: 'redirect to /dev/* (zero/null/sda etc.)',
    regex: />\s*\/dev\/[a-z0-9]+/i,
  },
  {
    id: 'fork_bomb',
    description: 'classic shell fork bomb',
    regex: /:\s*\(\s*\)\s*\{[\s\S]*?:\s*\|\s*:/i,
  },
  {
    id: 'sudo_invocation',
    description: 'sudo invocation (privilege elevation)',
    regex: /(^|\s)sudo\b/i,
  },
  {
    id: 'exec_call',
    description: 'exec() of arbitrary string',
    regex: /\bexec\s*\(/i,
  },
];

/**
 * Runs all malicious patterns against the given content. Returns the FIRST
 * match (callers reject the candidate immediately on the first hit).
 */
export function scanContent(
  content: string,
  patterns: PatternRule[] = MALICIOUS_PATTERNS,
): StaticScanFinding {
  const normalized = content.normalize('NFKC');
  for (const rule of patterns) {
    const match = rule.regex.exec(normalized);
    if (!match) continue;
    const upTo = normalized.slice(0, match.index);
    const line = upTo.split('\n').length;
    const excerpt = match[0]?.slice(0, 120);
    return { matched: rule.id, line, excerpt };
  }
  return { matched: null, line: 0 };
}

export interface FileScanResult {
  path: string;
  finding: StaticScanFinding;
}

/**
 * Scans an array of `{path, content}` pairs. Returns ALL findings (caller may
 * choose to fail-fast on first or aggregate; v1 fails on any).
 */
export function scanFiles(
  files: { path: string; content: string }[],
  patterns: PatternRule[] = MALICIOUS_PATTERNS,
): FileScanResult[] {
  const out: FileScanResult[] = [];
  for (const f of files) {
    const finding = scanContent(f.content, patterns);
    if (finding.matched !== null) {
      out.push({ path: f.path, finding });
    }
  }
  return out;
}
