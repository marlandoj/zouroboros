/**
 * Module coverage for grep-validate.ts. Hallucinated paths and unknown MCP
 * tools are flagged; references that resolve on disk pass.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateReferences } from '../../crystallize/grep-validate.js';

describe('crystallize/grep-validate', () => {
  test('missing path is flagged; existing path passes; unknown mcp tool flagged', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'crystallize-grep-'));
    try {
      mkdirSync(join(tmp, 'pkg'), { recursive: true });
      writeFileSync(join(tmp, 'pkg', 'real.ts'), '// hi\n');

      const skillMd = `# foo

Reads from \`pkg/real.ts\`. Calls \`mcp__zo__send_email_to_user\`.
References \`pkg/hallucinated.ts\`. Also pings \`mcp__zo__no_such_tool\`.
`;
      const out = validateReferences(skillMd, {
        projectRoot: tmp,
        knownMcpTools: new Set(['mcp__zo__send_email_to_user']),
      });
      expect(out.ok).toBe(false);
      expect(out.missingPaths).toEqual(['pkg/hallucinated.ts']);
      expect(out.unknownTools).toEqual(['mcp__zo__no_such_tool']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-path backticks (regex, regex variables) are skipped', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'crystallize-grep-'));
    try {
      const skillMd = '# foo\n\nUses `someVar` and `another_one`.\n';
      const out = validateReferences(skillMd, {
        projectRoot: tmp,
        knownMcpTools: new Set(),
      });
      expect(out.ok).toBe(true);
      expect(out.missingPaths).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
