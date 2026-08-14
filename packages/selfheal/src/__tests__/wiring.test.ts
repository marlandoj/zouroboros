import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyzeExports,
  findUnreachableExports,
  findBrokenPathRefs,
  checkTriggerBindings,
  analyzeEnvWrites,
  findUnreadEnvWrites,
  checkSentinelHandoffs,
  scanWiring,
  type WiringFinding,
} from '../introspect/wiring';

// getWorkspaceRoot() falls back to cwd; derive the real root from this test's location
// (.../packages/selfheal/src/__tests__) so file lookups are independent of cwd.
const WORKSPACE = join(import.meta.dir, '../../../..');

describe('wiring — Wiring Sentinel (E2)', () => {
  describe('AC-E2.1/E2.6 — un-called export detection + dynamic allowlist', () => {
    let fixtureDir: string;

    beforeAll(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), 'wiring-fixture-'));
      writeFileSync(
        join(fixtureDir, 'a.ts'),
        [
          'export function usedFn(): number { return 1; }',
          'export function deadFn(): number { return 2; }',
          'export function dynamicFn(): number { return 3; }',
        ].join('\n')
      );
      writeFileSync(
        join(fixtureDir, 'b.ts'),
        [
          "import { usedFn } from './a.js';",
          'export function main(): number { return usedFn() + 1; }',
          'export function caller(): number { return main(); }',
        ].join('\n')
      );
    });

    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    test('flags an exported callable with zero inbound references', () => {
      const findings = findUnreachableExports({
        srcDir: fixtureDir,
        projectRoot: fixtureDir,
        dynamicEntrypoints: ['dynamicFn'],
      });
      const symbols = findings.map((f) => f.symbol);
      expect(symbols).toContain('deadFn');
    });

    test('does NOT flag a referenced export', () => {
      const symbols = findUnreachableExports({
        srcDir: fixtureDir,
        projectRoot: fixtureDir,
        dynamicEntrypoints: ['dynamicFn'],
      }).map((f) => f.symbol);
      expect(symbols).not.toContain('usedFn');
    });

    test('does NOT flag a manifest dynamicEntrypoint (false-positive guard)', () => {
      const symbols = findUnreachableExports({
        srcDir: fixtureDir,
        projectRoot: fixtureDir,
        dynamicEntrypoints: ['dynamicFn'],
      }).map((f) => f.symbol);
      expect(symbols).not.toContain('dynamicFn');
    });

    test('all unreachable findings carry file:line evidence', () => {
      const findings = findUnreachableExports({
        srcDir: fixtureDir,
        projectRoot: fixtureDir,
        dynamicEntrypoints: ['dynamicFn'],
      });
      for (const f of findings) {
        expect(f.kind).toBe('unreachable');
        expect(f.evidence).toMatch(/\.ts:\d+$/);
      }
    });

    test('analyzeExports reports a positive declared-callable count', () => {
      const { declaredCallables } = analyzeExports({
        srcDir: fixtureDir,
        projectRoot: fixtureDir,
      });
      expect(declaredCallables).toBeGreaterThanOrEqual(5);
    });
  });

  describe('AC-E2.3 — broken path refs flagged (detector proof) + registry remediation', () => {
    // The detector proof runs on a SELF-CONTAINED synthetic fixture (matching the
    // unreachable/env/sentinel tests in this file) rather than relying on production source
    // to contain live defects: a path literal that resolves on disk must be ignored, and one
    // that does not must be flagged with file:line evidence.
    describe('detector flags a genuinely-missing path literal', () => {
      let fixtureDir: string;

      beforeAll(() => {
        fixtureDir = mkdtempSync(join(tmpdir(), 'wiring-pathref-'));
        // A real file the PRESENT ref points at, so it resolves relative to projectRoot.
        mkdirSync(join(fixtureDir, 'packages/real'), { recursive: true });
        writeFileSync(join(fixtureDir, 'packages/real/present.ts'), 'export const x = 1;\n');
        writeFileSync(
          join(fixtureDir, 'refs.ts'),
          [
            "export const PRESENT = 'packages/real/present.ts';",
            "export const PHANTOM = 'packages/does-not-exist/phantom.ts';",
          ].join('\n')
        );
      });

      afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

      test('flags a path literal that does not resolve, with file:line evidence', () => {
        const broken = findBrokenPathRefs({
          files: [join(fixtureDir, 'refs.ts')],
          projectRoot: fixtureDir,
        }).filter((f) => f.kind === 'broken_path_ref');
        expect(broken.some((f) => f.symbol === 'packages/does-not-exist/phantom.ts')).toBe(true);
        for (const f of broken) expect(f.evidence).toMatch(/\.ts:\d+$/);
      });

      test('does NOT flag a path literal that resolves on disk', () => {
        const findings = findBrokenPathRefs({
          files: [join(fixtureDir, 'refs.ts')],
          projectRoot: fixtureDir,
        });
        expect(findings.some((f) => f.symbol === 'packages/real/present.ts')).toBe(false);
      });
    });

    // Remediation proof: the layout-drift registry phantoms that moved Skills/* → packages/*
    // were repointed to their real homes, so the detector must NO LONGER flag them in the live
    // playbook/standalone source — proving the sentinel responds to a real remediation instead
    // of hard-coding a pass. (Runtime-resolved Skills/zo-memory-system/* refs that exist in the
    // deployment workspace are intentionally out of scope and not asserted here.)
    describe('layout-drift registry refs are remediated', () => {
      let findings: WiringFinding[];

      beforeAll(() => {
        findings = findBrokenPathRefs({
          files: [
            join(WORKSPACE, 'packages/selfheal/src/standalone/prescribe.ts'),
            join(WORKSPACE, 'packages/selfheal/src/prescribe/playbook.ts'),
            join(WORKSPACE, 'packages/selfheal/src/standalone/evolve.ts'),
          ],
          projectRoot: WORKSPACE,
        });
      });

      const REMEDIATED = [
        'Skills/zo-swarm-orchestrator/scripts/routing-weights.ts',
        'Skills/three-stage-eval/scripts/evaluate.ts',
        'Skills/zouroboros-introspect/scripts/analyze-velocity.ts',
        'Skills/autoloop/scripts/autoloop.ts',
      ];
      for (const ref of REMEDIATED) {
        test(`no longer references the moved path ${ref}`, () => {
          expect(findings.some((f) => f.symbol === ref)).toBe(false);
        });
      }

      test('does NOT flag the remediated INTROSPECT scorecard path (responsive to AC-S.2 fix)', () => {
        // The remediated path now resolves on disk, so it must never appear; and the old phantom
        // Skills/zouroboros-introspect/scripts/introspect.ts must be fully gone from both sites.
        const remediated = findings.filter((f) => f.symbol.includes('cli/introspect.ts'));
        expect(remediated).toHaveLength(0);
        const stalePhantom = findings.filter((f) =>
          f.symbol.includes('Skills/zouroboros-introspect/scripts/introspect.ts')
        );
        expect(stalePhantom).toHaveLength(0);
      });

      test('every broken_path_ref carries file:line evidence', () => {
        const broken = findings.filter((f) => f.kind === 'broken_path_ref');
        for (const f of broken) {
          expect(f.evidence).toMatch(/\.ts:\d+$/);
        }
      });
    });
  });

  describe('AC-E2.2 — trigger binding resolution', () => {
    test('flags a trigger whose expected caller does not resolve', () => {
      const findings = checkTriggerBindings(
        [{ capability: 'phantom-cli', expectedCaller: 'Skills/does-not-exist/run.ts' }],
        WORKSPACE
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe('unbound_trigger');
    });

    test('does NOT flag a trigger whose expected caller resolves', () => {
      const findings = checkTriggerBindings(
        [
          {
            capability: 'real-introspect',
            expectedCaller: 'Skills/zouroboros/skills/selfheal/scripts/introspect.ts',
          },
        ],
        WORKSPACE
      );
      expect(findings).toHaveLength(0);
    });
  });

  describe('ZOU-278 — cross-process state detection (env writes)', () => {
    let dir: string;
    const w = (name: string, body: string) => writeFileSync(join(dir, name), body);

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'wiring-env-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test('flags an env var SET but never READ (unread_env) with file:line evidence', () => {
      const d = mkdtempSync(join(tmpdir(), 'env-dead-'));
      writeFileSync(join(d, 'producer.ts'), "process.env.DEAD_HANDOFF = 'x';\n");
      const findings = findUnreadEnvWrites({ srcDir: d, projectRoot: d });
      const f = findings.find((x) => x.symbol === 'DEAD_HANDOFF');
      expect(f?.kind).toBe('unread_env');
      expect(f?.evidence).toMatch(/\.ts:\d+$/);
      rmSync(d, { recursive: true, force: true });
    });

    test('does NOT flag an env var that IS read elsewhere in source', () => {
      const d = mkdtempSync(join(tmpdir(), 'env-live-'));
      writeFileSync(join(d, 'producer.ts'), "process.env.LIVE = 'x';\n");
      writeFileSync(join(d, 'consumer.ts'), 'export const v = process.env.LIVE;\n');
      const symbols = findUnreadEnvWrites({ srcDir: d, projectRoot: d }).map((x) => x.symbol);
      expect(symbols).not.toContain('LIVE');
      rmSync(d, { recursive: true, force: true });
    });

    test('a destructured read (const { X } = process.env) counts as consuming X', () => {
      const d = mkdtempSync(join(tmpdir(), 'env-destr-'));
      writeFileSync(join(d, 'producer.ts'), "process.env.VIA_DESTRUCTURE = 'x';\n");
      writeFileSync(
        join(d, 'consumer.ts'),
        'export function r() { const { VIA_DESTRUCTURE } = process.env; return VIA_DESTRUCTURE; }\n'
      );
      const symbols = findUnreadEnvWrites({ srcDir: d, projectRoot: d }).map((x) => x.symbol);
      expect(symbols).not.toContain('VIA_DESTRUCTURE');
      rmSync(d, { recursive: true, force: true });
    });

    test('crossProcessExports allowlist suppresses the unread_env finding', () => {
      const d = mkdtempSync(join(tmpdir(), 'env-allow-'));
      writeFileSync(join(d, 'producer.ts'), "process.env.FOR_CHILD = 'x';\n");
      const symbols = findUnreadEnvWrites({
        srcDir: d,
        projectRoot: d,
        crossProcessExports: ['FOR_CHILD'],
      }).map((x) => x.symbol);
      expect(symbols).not.toContain('FOR_CHILD');
      rmSync(d, { recursive: true, force: true });
    });

    test('a BULK use of process.env (spread to a child) suppresses all unread_env findings', () => {
      const d = mkdtempSync(join(tmpdir(), 'env-bulk-'));
      writeFileSync(join(d, 'producer.ts'), "process.env.MAYBE_CONSUMED = 'x';\n");
      writeFileSync(
        join(d, 'spawn.ts'),
        'export const childEnv = { ...process.env, EXTRA: 1 };\n'
      );
      const findings = findUnreadEnvWrites({ srcDir: d, projectRoot: d });
      expect(findings).toHaveLength(0);
      rmSync(d, { recursive: true, force: true });
    });

    test('analyzeEnvWrites reports the declaredWrites denominator', () => {
      w('multi.ts', "process.env.A = '1'; process.env.B = '2';\n");
      const { declaredWrites } = analyzeEnvWrites({ srcDir: dir, projectRoot: dir });
      expect(declaredWrites).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ZOU-278 — cross-process state detection (file sentinels)', () => {
    test('flags a declared sentinel WRITTEN but never READ (producer, no consumer)', () => {
      const d = mkdtempSync(join(tmpdir(), 'sent-w-'));
      writeFileSync(
        join(d, 'producer.ts'),
        "import { writeFileSync } from 'fs';\nimport { join } from 'path';\nexport function p(root: string) { writeFileSync(join(root, '.zo/handoff.sentinel'), 'go'); }\n"
      );
      const findings = checkSentinelHandoffs(
        [{ capability: 'handoff', pathFragment: '.zo/handoff.sentinel' }],
        { files: [join(d, 'producer.ts')], projectRoot: d }
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe('half_wired_sentinel');
      expect(findings[0]!.evidence).toMatch(/never read/);
      rmSync(d, { recursive: true, force: true });
    });

    test('flags a declared sentinel READ but never WRITTEN (consumer, no producer)', () => {
      const d = mkdtempSync(join(tmpdir(), 'sent-r-'));
      writeFileSync(
        join(d, 'consumer.ts'),
        "import { existsSync } from 'fs';\nexport function c() { return existsSync('.zo/orphan.sentinel'); }\n"
      );
      const findings = checkSentinelHandoffs(
        [{ capability: 'orphan', pathFragment: '.zo/orphan.sentinel' }],
        { files: [join(d, 'consumer.ts')], projectRoot: d }
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.evidence).toMatch(/never written/);
      rmSync(d, { recursive: true, force: true });
    });

    test('does NOT flag a sentinel with BOTH a writer and a reader (computed paths matched)', () => {
      const d = mkdtempSync(join(tmpdir(), 'sent-ok-'));
      writeFileSync(
        join(d, 'producer.ts'),
        "import { writeFileSync } from 'fs';\nimport { join } from 'path';\nexport function p(root: string) { writeFileSync(join(root, '.zo/ok.sentinel'), 'go'); }\n"
      );
      writeFileSync(
        join(d, 'consumer.ts'),
        "import { readFileSync } from 'fs';\nimport { join } from 'path';\nexport function c(root: string) { return readFileSync(join(root, '.zo/ok.sentinel'), 'utf-8'); }\n"
      );
      const findings = checkSentinelHandoffs(
        [{ capability: 'ok', pathFragment: '.zo/ok.sentinel' }],
        { files: [join(d, 'producer.ts'), join(d, 'consumer.ts')], projectRoot: d }
      );
      expect(findings).toHaveLength(0);
      rmSync(d, { recursive: true, force: true });
    });

    test('no declared handoffs → no findings', () => {
      expect(checkSentinelHandoffs([], {})).toHaveLength(0);
    });
  });

  describe('scanWiring — full pass over the real package', () => {
    test('returns a coherent report (declared >= wired >= 0)', () => {
      const report = scanWiring();
      expect(report.declared).toBeGreaterThan(0);
      expect(report.wired).toBeGreaterThanOrEqual(0);
      expect(report.wired).toBeLessThanOrEqual(report.declared);
      expect(Array.isArray(report.findings)).toBe(true);
    });

    test('the real package scan surfaces the broken_path_ref defects', () => {
      // The selfheal library is dual-homed: it lives in this monorepo but references
      // runtime `Skills/…` paths that ship with the Zo workspace, not the repo. Those refs
      // are unresolvable in an isolated CI checkout by design, so the Wiring Sentinel must
      // surface them — this is a detector proof, not a defect to drive to zero here.
      const report = scanWiring();
      const broken = report.findings.filter((f) => f.kind === 'broken_path_ref');
      expect(broken.length).toBeGreaterThanOrEqual(2);
    });

    test('the real source has NO cross-process defects (env writes are read in-process; no half-wired sentinels)', () => {
      const report = scanWiring();
      const cross = report.findings.filter(
        (f) => f.kind === 'unread_env' || f.kind === 'half_wired_sentinel'
      );
      expect(cross).toEqual([]);
    });
  });
});
