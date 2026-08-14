import { test, expect, describe } from 'bun:test';
import { parseWorkflowUses, auditActionPins, type ShaResolver } from './action-pin-audit.js';

const FAKE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('parseWorkflowUses', () => {
  test('extracts a mutable-tag remote ref', () => {
    const refs = parseWorkflowUses('      - uses: actions/checkout@v4\n', 'ci.yml');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      owner: 'actions',
      repo: 'checkout',
      ref: 'v4',
      kind: 'remote',
      isSha: false,
      line: 1,
    });
  });

  test('recognizes a 40-hex SHA pin', () => {
    const refs = parseWorkflowUses(`      - uses: actions/checkout@${FAKE_SHA}\n`, 'ci.yml');
    expect(refs[0].isSha).toBe(true);
    expect(refs[0].kind).toBe('remote');
  });

  test('classifies a local ./ action', () => {
    const refs = parseWorkflowUses('      - uses: ./.github/actions/build\n', 'ci.yml');
    expect(refs[0].kind).toBe('local');
    expect(refs[0].isSha).toBe(false);
  });

  test('classifies a docker:// action', () => {
    const refs = parseWorkflowUses('      - uses: docker://alpine:3.18\n', 'ci.yml');
    expect(refs[0].kind).toBe('docker');
  });

  test('strips inline comments and quotes', () => {
    const refs = parseWorkflowUses('      - uses: "actions/checkout@v4"  # pinned later\n', 'ci.yml');
    expect(refs[0].ref).toBe('v4');
    expect(refs[0].uses).toBe('actions/checkout@v4');
  });

  test('ignores commented-out uses lines', () => {
    const refs = parseWorkflowUses('      # - uses: actions/checkout@v4\n', 'ci.yml');
    expect(refs).toHaveLength(0);
  });

  test('handles owner/repo/subpath@ref', () => {
    const refs = parseWorkflowUses('      - uses: github/codeql-action/init@v3\n', 'ci.yml');
    expect(refs[0]).toMatchObject({ owner: 'github', repo: 'codeql-action', ref: 'v3', isSha: false });
  });

  test('handles a remote ref with no @ (unpinned)', () => {
    const refs = parseWorkflowUses('      - uses: some/action\n', 'ci.yml');
    expect(refs[0]).toMatchObject({ owner: 'some', repo: 'action', kind: 'remote', isSha: false });
    expect(refs[0].ref).toBeUndefined();
  });

  test('parses multiple uses across lines with correct line numbers', () => {
    const yaml = ['steps:', '  - uses: actions/checkout@v4', '  - run: echo hi', '  - uses: oven-sh/setup-bun@v2'].join('\n');
    const refs = parseWorkflowUses(yaml, 'ci.yml');
    expect(refs).toHaveLength(2);
    expect(refs[0].line).toBe(2);
    expect(refs[1].line).toBe(4);
  });
});

describe('auditActionPins', () => {
  test('flags a mutable tag as critical', () => {
    const refs = parseWorkflowUses('      - uses: actions/checkout@v4\n', 'ci.yml');
    const findings = auditActionPins(refs);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].category).toBe('action-pin');
    expect(findings[0].remediation).toContain('<commit-sha>');
  });

  test('passes a SHA-pinned ref (no finding)', () => {
    const refs = parseWorkflowUses(`      - uses: actions/checkout@${FAKE_SHA}\n`, 'ci.yml');
    expect(auditActionPins(refs)).toHaveLength(0);
  });

  test('skips local and docker refs', () => {
    const refs = parseWorkflowUses(
      ['  - uses: ./.github/actions/build', '  - uses: docker://alpine:3.18'].join('\n'),
      'ci.yml',
    );
    expect(auditActionPins(refs)).toHaveLength(0);
  });

  test('uses an injected resolver for the suggested SHA (offline)', () => {
    const resolver: ShaResolver = (o, r, ref) => (o === 'actions' && r === 'checkout' && ref === 'v4' ? FAKE_SHA : null);
    const refs = parseWorkflowUses('      - uses: actions/checkout@v4\n', 'ci.yml');
    const findings = auditActionPins(refs, resolver);
    expect(findings[0].remediation).toContain(FAKE_SHA);
    expect(findings[0].remediation).toContain('# v4');
  });

  test('a throwing resolver degrades gracefully to the generic hint', () => {
    const resolver: ShaResolver = () => {
      throw new Error('network down');
    };
    const refs = parseWorkflowUses('      - uses: actions/checkout@v4\n', 'ci.yml');
    const findings = auditActionPins(refs, resolver);
    expect(findings).toHaveLength(1);
    expect(findings[0].remediation).toContain('<commit-sha>');
  });
});
