/**
 * Fixture-driven tests for static-scan + AC-Q4 mutation tests.
 * Covers FX-05, FX-06, FX-07.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scanContent } from '../../crystallize/static-scan.js';

const FIX = join(import.meta.dir, '..', 'fixtures', 'crystallize');

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

describe('crystallize/static-scan (FX-05,06,07)', () => {
  test('FX-05 rm -rf detected; ≥3 mutations remain blocked', () => {
    const fx = loadFixture('FX-05-poisoned-procedure-rmrf.json');
    expect(scanContent(fx.input.content).matched).toBe(fx.expected.matched);
    expect(fx.mutations.length).toBeGreaterThanOrEqual(3);
    for (const variant of fx.mutations) {
      expect(scanContent(variant).matched).not.toBeNull();
    }
  });

  test('FX-06 curl|bash detected; mutations + wget variant remain blocked', () => {
    const fx = loadFixture('FX-06-poisoned-procedure-curlbash.json');
    expect(scanContent(fx.input.content).matched).toBe(fx.expected.matched);
    expect(fx.mutations.length).toBeGreaterThanOrEqual(3);
    for (const variant of fx.mutations) {
      const f = scanContent(variant);
      expect(f.matched).not.toBeNull();
    }
    // Last mutation in the fixture is wget|sh — must catch on the wget rule.
    const wgetVariant = fx.mutations[fx.mutations.length - 1];
    expect(scanContent(wgetVariant).matched).toBe(fx.expected.wgetVariantMatchedAs);
  });

  test('FX-07 eval/os.system/subprocess(shell=True) detected with correct pattern IDs', () => {
    const fx = loadFixture('FX-07-poisoned-procedure-evalstr.json');
    expect(scanContent(fx.input.content).matched).toBe(fx.expected.matched);
    for (const [variant, expectedId] of Object.entries(fx.expected.patternMappings) as [string, string][]) {
      const finding = scanContent(variant);
      expect(finding.matched).toBe(expectedId);
    }
  });

  test('clean content returns no match', () => {
    const finding = scanContent('// just a comment\nconsole.log("hi");\n');
    expect(finding.matched).toBeNull();
  });
});
