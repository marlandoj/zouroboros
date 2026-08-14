/**
 * Mechanical eval coverage — drives FX-11 (clean pass) and a stub-injected
 * typecheck failure path. Static-scan / grep-validate / slug failures are
 * exercised in their dedicated module tests; this suite asserts the
 * orchestrator wires them correctly and emits the required event payload.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateMechanical,
  type TypeCheckDriver,
} from '../../crystallize/eval-mechanical.js';
import type { DraftedSkill } from '../../crystallize/draft.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

const KNOWN_TOOLS = new Set(['Bash', 'Edit', 'Read']);
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('crystallize/eval-mechanical', () => {
  test('FX-11 — clean candidate yields mechanical_pass with one event', async () => {
    const fx = FX('FX-11-mechanical-pass');
    const drafted: DraftedSkill = {
      slug: fx.input.slug,
      files: fx.input.files,
      llm_cost_usd: 0,
    };

    const result = await evaluateMechanical(drafted, {
      projectRoot: PROJECT_ROOT,
      knownMcpTools: KNOWN_TOOLS,
    });

    expect(result.status).toBe(fx.expected.status);
    expect(result.events.length).toBe(fx.expected.eventCount);
    expect(result.failures.length).toBe(fx.expected.failureCount);
    expect(result.events[0].event_type).toBe('mechanical_eval');
    expect(result.events[0].payload.status).toBe('mechanical_pass');
    expect(result.events[0].payload.slug_ok).toBe(true);
  });

  test('typecheck driver failure surfaces in failures array and event payload', async () => {
    const drafted: DraftedSkill = {
      slug: 'broken-stub',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: broken-stub\ndescription: x\n---\n\n# broken-stub\n',
        },
        {
          path: 'scripts/bash.ts',
          content: 'export const x =;',
        },
      ],
      llm_cost_usd: 0,
    };

    const failingDriver: TypeCheckDriver = async (files) =>
      files
        .filter((f) => f.path.endsWith('.ts'))
        .map((f) => ({ path: f.path, message: 'unexpected token' }));

    const result = await evaluateMechanical(drafted, {
      projectRoot: PROJECT_ROOT,
      knownMcpTools: KNOWN_TOOLS,
      typecheck: failingDriver,
    });

    expect(result.status).toBe('mechanical_fail');
    expect(result.failures.some((f) => f.stage === 'typecheck')).toBe(true);
    const errors = result.events[0].payload.typecheck_errors as Array<{
      path: string;
    }>;
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('scripts/bash.ts');
  });

  test('default typecheck driver (Bun.Transpiler) catches broken syntax with no opts.typecheck', async () => {
    const drafted: DraftedSkill = {
      slug: 'broken-default-driver',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: broken-default-driver\ndescription: x\n---\n\n# broken-default-driver\n',
        },
        {
          path: 'scripts/bash.ts',
          content: 'export const x =;',
        },
      ],
      llm_cost_usd: 0,
    };

    const result = await evaluateMechanical(drafted, {
      projectRoot: PROJECT_ROOT,
      knownMcpTools: KNOWN_TOOLS,
    });

    expect(result.status).toBe('mechanical_fail');
    expect(result.failures.some((f) => f.stage === 'typecheck')).toBe(true);
    const errors = result.events[0].payload.typecheck_errors as Array<{
      path: string;
    }>;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toBe('scripts/bash.ts');
  });

  test('grep-validate failure (bad backticked path in SKILL.md) surfaces in orchestrator', async () => {
    const drafted: DraftedSkill = {
      slug: 'bad-ref-stub',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: bad-ref-stub\ndescription: x\n---\n\n# bad-ref-stub\n\nRun `scripts/does-not-exist.ts` to start.\n',
        },
        {
          path: 'scripts/bash.ts',
          content: 'export const x = 1;\n',
        },
      ],
      llm_cost_usd: 0,
    };

    const result = await evaluateMechanical(drafted, {
      projectRoot: PROJECT_ROOT,
      knownMcpTools: KNOWN_TOOLS,
    });

    expect(result.status).toBe('mechanical_fail');
    expect(result.failures.some((f) => f.stage === 'grep_validate')).toBe(true);
  });

  test('static-scan hit (rm -rf) blocks before typecheck', async () => {
    const drafted: DraftedSkill = {
      slug: 'malicious-stub',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: malicious-stub\ndescription: x\n---\n\n# malicious-stub\n',
        },
        {
          path: 'scripts/bash.ts',
          content: '// rm -rf $HOME\nexport const x = 1;\n',
        },
      ],
      llm_cost_usd: 0,
    };

    const result = await evaluateMechanical(drafted, {
      projectRoot: PROJECT_ROOT,
      knownMcpTools: KNOWN_TOOLS,
    });

    expect(result.status).toBe('mechanical_fail');
    const hits = result.events[0].payload.static_scan_hits as Array<unknown>;
    expect(hits.length).toBeGreaterThan(0);
  });
});
