import { describe, test, expect } from 'bun:test';
import { stringify as yamlStringify } from 'yaml';
import {
  canonicalizePlanArtifact,
  hashPlanArtifact,
  canonicalizePlanInput,
  hashPlanInput,
  parsePlanArtifactInput,
} from '../canonicalize.js';
import type { PlanArtifact } from '../types.js';

const BASE: PlanArtifact = {
  id: 'test-001',
  title: 'Test plan',
  risk: 'low',
  tasks: [
    { id: 'T1', title: 'First task', paths: ['src/foo.ts'] },
    { id: 'T2', title: 'Second task', paths: ['src/bar.ts'], depends_on: ['T1'] },
  ],
  acceptance_criteria: ['All tests pass', 'No regressions'],
  exit_conditions: [{ name: 'ci_green', criteria: 'CI passes on main' }],
  rollback: 'revert T1 and T2',
};

// ---------------------------------------------------------------------------
// canonicalizePlanArtifact
// ---------------------------------------------------------------------------

describe('canonicalizePlanArtifact', () => {
  test('same object produces the same canonical string', () => {
    expect(canonicalizePlanArtifact(BASE)).toBe(canonicalizePlanArtifact(BASE));
  });

  test('different objects produce different canonical strings', () => {
    const other: PlanArtifact = { ...BASE, id: 'test-002', title: 'Different' };
    expect(canonicalizePlanArtifact(BASE)).not.toBe(canonicalizePlanArtifact(other));
  });

  test('trailing whitespace in string fields does not change canonical output', () => {
    const withWhitespace: PlanArtifact = { ...BASE, title: '  Test plan  ' };
    expect(canonicalizePlanArtifact(withWhitespace)).toBe(canonicalizePlanArtifact(BASE));
  });

  test('output is valid JSON', () => {
    const canonical = canonicalizePlanArtifact(BASE);
    expect(() => JSON.parse(canonical)).not.toThrow();
  });

  test('keys are sorted alphabetically in output', () => {
    const canonical = canonicalizePlanArtifact(BASE);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  test('rollback null is preserved', () => {
    const nullRollback: PlanArtifact = { ...BASE, rollback: null };
    const canonical = canonicalizePlanArtifact(nullRollback);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    expect(parsed['rollback']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hashPlanArtifact
// ---------------------------------------------------------------------------

describe('hashPlanArtifact', () => {
  test('returns a 64-character lowercase hex string (SHA-256)', () => {
    const hash = hashPlanArtifact(BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hash is deterministic across calls', () => {
    expect(hashPlanArtifact(BASE)).toBe(hashPlanArtifact(BASE));
  });

  test('different artifacts have different hashes', () => {
    const other: PlanArtifact = { ...BASE, id: 'test-002' };
    expect(hashPlanArtifact(BASE)).not.toBe(hashPlanArtifact(other));
  });

  test('whitespace-only difference does not change hash', () => {
    const trimmed: PlanArtifact = { ...BASE, title: 'Test plan' };
    const padded: PlanArtifact = { ...BASE, title: '  Test plan  ' };
    expect(hashPlanArtifact(trimmed)).toBe(hashPlanArtifact(padded));
  });
});

// ---------------------------------------------------------------------------
// Format parity (AC-01: semantically equivalent inputs → same hash)
// ---------------------------------------------------------------------------

describe('format parity', () => {
  test('JSON and YAML with the same data produce the same canonical string', () => {
    const jsonInput = JSON.stringify(BASE);
    const yamlInput = yamlStringify(BASE);
    expect(canonicalizePlanInput(jsonInput, 'json')).toBe(
      canonicalizePlanInput(yamlInput, 'yaml')
    );
  });

  test('JSON and YAML with the same data hash identically', () => {
    const jsonInput = JSON.stringify(BASE);
    const yamlInput = yamlStringify(BASE);
    expect(hashPlanInput(jsonInput, 'json')).toBe(hashPlanInput(yamlInput, 'yaml'));
  });

  test('Markdown with YAML frontmatter hashes same as YAML alone', () => {
    const yamlBody = yamlStringify(BASE);
    const markdown = `---\n${yamlBody}\n---\n\n# Some prose that is ignored.\n`;
    expect(hashPlanInput(yamlBody, 'yaml')).toBe(hashPlanInput(markdown, 'markdown'));
  });

  test('Markdown without frontmatter is treated as content object', () => {
    const md = 'This is plain markdown with no frontmatter.';
    const parsed = parsePlanArtifactInput(md, 'markdown') as Record<string, unknown>;
    expect(parsed['content']).toBe(md);
  });

  test('YAML with reordered top-level keys hashes same as original', () => {
    // Build a YAML where the id comes last instead of first
    const reordered = {
      title: BASE.title,
      risk: BASE.risk,
      tasks: BASE.tasks,
      acceptance_criteria: BASE.acceptance_criteria,
      exit_conditions: BASE.exit_conditions,
      rollback: BASE.rollback,
      id: BASE.id,
    } as unknown as PlanArtifact;
    const originalYaml = yamlStringify(BASE);
    const reorderedYaml = yamlStringify(reordered);
    expect(hashPlanInput(originalYaml, 'yaml')).toBe(
      hashPlanInput(reorderedYaml, 'yaml')
    );
  });
});

// ---------------------------------------------------------------------------
// parsePlanArtifactInput
// ---------------------------------------------------------------------------

describe('parsePlanArtifactInput', () => {
  test('parses JSON input', () => {
    const result = parsePlanArtifactInput(JSON.stringify(BASE), 'json') as PlanArtifact;
    expect(result.id).toBe(BASE.id);
    expect(result.title).toBe(BASE.title);
  });

  test('parses YAML input', () => {
    const result = parsePlanArtifactInput(yamlStringify(BASE), 'yaml') as PlanArtifact;
    expect(result.id).toBe(BASE.id);
    expect(result.title).toBe(BASE.title);
  });

  test('extracts YAML frontmatter from Markdown', () => {
    const frontmatter = `id: md-test\ntitle: Markdown plan\nrisk: low\n`;
    const md = `---\n${frontmatter}\n---\n\n# Prose section\n`;
    const result = parsePlanArtifactInput(md, 'markdown') as Record<string, unknown>;
    expect(result['id']).toBe('md-test');
    expect(result['title']).toBe('Markdown plan');
  });

  test('wraps plain Markdown body as content field', () => {
    const md = 'No frontmatter here.';
    const result = parsePlanArtifactInput(md, 'markdown') as Record<string, unknown>;
    expect(result['content']).toBe(md);
  });
});
