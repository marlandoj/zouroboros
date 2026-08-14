/**
 * Eval–Production Metric Parity (ZOU-277 — Wiring Sentinel hardening, #2).
 *
 * Mechanizes the gap-audit's 4th, still-hand-checked column: eval/production parity.
 * The production introspect surface (the metrics buildScorecard() emits, declared by the
 * buildMetric() calls in collector.ts) and the optimizer surface (the MultiMetricOptimizer
 * objective targets in multi-metric.ts) MUST grade the same metric set. When a metric lives
 * on one surface but not the other — the exact ZouroBench failure mode where retrieval
 * capabilities lived only in the benchmark adapter and inflated the score — the loop measures
 * one function while optimizing a different one. This module diffs the two surfaces
 * STATICALLY (TS compiler API, like wiring.ts) and reports asymmetries with file:line evidence.
 *
 * Discipline (matches the Wiring Sentinel): REPORT-and-ESCALATE only. Intentional
 * asymmetries — weight-0 display tripwires and not-yet-optimized metrics — are allowlisted in
 * parity-manifest.json, so the tripwire fires only on UNDECLARED divergence: a metric added,
 * removed, or reweighted on one surface without the other (or the manifest) being updated.
 *
 * tsc note: type-checked (src/introspect/). Uses only the installed `typescript` compiler
 * API + fs/path/url — no bun:sqlite / Skills imports on the type-checked path.
 */

import ts from 'typescript';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { isAbsolute, join, relative } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';

const WORKSPACE = getWorkspaceRoot();

export type ParityKind =
  | 'only_in_production'
  | 'only_in_optimizer'
  | 'weight_mismatch'
  | 'inconsistent_weight';

export interface MetricDecl {
  name: string;
  weight: number;
  /** file:line of the declaration (workspace-relative when read from disk). */
  evidence: string;
}

export interface ParityFinding {
  kind: ParityKind;
  metric: string;
  /** Human-readable proof, carrying the file:line of the offending declaration(s). */
  evidence: string;
}

export interface ParityManifest {
  /** Metrics intentionally on the production surface but NOT optimizer targets. */
  intentionalExclusions: { name: string; reason: string }[];
  /** Weight differences between the two surfaces that are intentional and locked. */
  acceptedWeightDivergences: {
    name: string;
    scorecardWeight: number;
    optimizerWeight: number;
    reason: string;
  }[];
}

export interface ParityReport {
  productionCount: number;
  optimizerCount: number;
  /** Distinct metric names across the union of both surfaces. */
  declared: number;
  /** Union metrics with zero findings (consistent or allowlisted). */
  aligned: number;
  findings: ParityFinding[];
}

const EMPTY_MANIFEST: ParityManifest = {
  intentionalExclusions: [],
  acceptedWeightDivergences: [],
};

const WEIGHT_EPS = 1e-9;

function resolveExisting(primary: string, fallback: string): string {
  return existsSync(primary) ? primary : fallback;
}

function collectorPath(): string {
  return resolveExisting(
    fileURLToPath(new URL('./collector.ts', import.meta.url)),
    join(WORKSPACE, 'packages/selfheal/src/introspect/collector.ts')
  );
}

function optimizerPath(): string {
  return resolveExisting(
    fileURLToPath(new URL('../multi-metric.ts', import.meta.url)),
    join(WORKSPACE, 'packages/selfheal/src/multi-metric.ts')
  );
}

function manifestPath(): string {
  return resolveExisting(
    fileURLToPath(new URL('./parity-manifest.json', import.meta.url)),
    join(WORKSPACE, 'packages/selfheal/src/introspect/parity-manifest.json')
  );
}

export function loadParityManifest(path: string = manifestPath()): ParityManifest {
  if (!existsSync(path)) return { ...EMPTY_MANIFEST };
  try {
    const p = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ParityManifest>;
    return {
      intentionalExclusions: p.intentionalExclusions ?? [],
      acceptedWeightDivergences: p.acceptedWeightDivergences ?? [],
    };
  } catch {
    return { ...EMPTY_MANIFEST };
  }
}

function evidenceFor(file: string, line: number): string {
  const rel = isAbsolute(file) ? relative(WORKSPACE, file) : file;
  return `${rel}:${line}`;
}

/** Read a numeric literal (incl. unary-minus), else null for non-literal weights. */
function numericValue(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) return parseFloat(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -parseFloat(node.operand.text);
  }
  return null;
}

export interface ExtractOptions {
  file?: string;
  source?: string;
  /** Label used in evidence when parsing injected source (tests). */
  label?: string;
}

function sourceFileFor(
  opts: ExtractOptions,
  defaultFile: () => string
): { sf: ts.SourceFile; file: string } {
  if (opts.source !== undefined) {
    const file = opts.label ?? 'inline.ts';
    return {
      sf: ts.createSourceFile(file, opts.source, ts.ScriptTarget.ES2022, true),
      file,
    };
  }
  const file = opts.file ?? defaultFile();
  const text = readFileSync(file, 'utf-8');
  return {
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true),
    file,
  };
}

export interface ScorecardSurface {
  metrics: MetricDecl[];
  /** Metrics whose buildMetric branches disagree on the weight literal. */
  inconsistencies: ParityFinding[];
}

/**
 * Production metric surface: every buildMetric('<Name>', value, target, critical, <weight>, …)
 * call in collector.ts. A metric may be emitted from multiple branches; if those branches
 * disagree on the weight literal it is itself a defect (inconsistent_weight). Returns one
 * MetricDecl per metric name (first occurrence's evidence + weight).
 */
export function extractScorecardSurface(opts: ExtractOptions = {}): ScorecardSurface {
  const { sf, file } = sourceFileFor(opts, collectorPath);
  const byName = new Map<string, MetricDecl>();
  const weightsByName = new Map<string, Set<number>>();

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'buildMetric' &&
      node.arguments.length >= 5
    ) {
      const nameArg = node.arguments[0];
      const weightVal = numericValue(node.arguments[4]);
      if (ts.isStringLiteralLike(nameArg) && weightVal !== null) {
        const name = nameArg.text;
        const line = sf.getLineAndCharacterOfPosition(nameArg.getStart(sf)).line + 1;
        if (!byName.has(name)) {
          byName.set(name, { name, weight: weightVal, evidence: evidenceFor(file, line) });
        }
        const set = weightsByName.get(name) ?? new Set<number>();
        set.add(weightVal);
        weightsByName.set(name, set);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const inconsistencies: ParityFinding[] = [];
  for (const [name, set] of weightsByName) {
    if (set.size > 1) {
      inconsistencies.push({
        kind: 'inconsistent_weight',
        metric: name,
        evidence: `${name} declared with conflicting weights [${[...set]
          .sort((a, b) => a - b)
          .join(', ')}] — ${byName.get(name)!.evidence}`,
      });
    }
  }

  return { metrics: [...byName.values()], inconsistencies };
}

/**
 * Optimizer surface: every object literal carrying metricName + weight + direction in
 * multi-metric.ts — the OptimizationTarget entries of defaultObjective().targets.
 */
export function extractOptimizerSurface(opts: ExtractOptions = {}): MetricDecl[] {
  const { sf, file } = sourceFileFor(opts, optimizerPath);
  const out: MetricDecl[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let name: string | null = null;
      let weight: number | null = null;
      let hasDirection = false;
      let nameNode: ts.Node | null = null;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        if (key === 'metricName' && ts.isStringLiteralLike(prop.initializer)) {
          name = prop.initializer.text;
          nameNode = prop.initializer;
        } else if (key === 'weight') {
          weight = numericValue(prop.initializer);
        } else if (key === 'direction') {
          hasDirection = true;
        }
      }
      if (name !== null && weight !== null && hasDirection && nameNode && !seen.has(name)) {
        seen.add(name);
        const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
        out.push({ name, weight, evidence: evidenceFor(file, line) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface ScanParityOptions {
  /** Injected production (collector.ts) source for deterministic tests. */
  productionSource?: string;
  /** Injected optimizer (multi-metric.ts) source for deterministic tests. */
  optimizerSource?: string;
  manifest?: ParityManifest;
}

/**
 * Diff the production scorecard surface against the optimizer objective surface and report
 * every undeclared asymmetry:
 *   - only_in_production : measured/displayed but not an optimizer target (and not allowlisted)
 *   - only_in_optimizer  : an optimizer target with no production collector (phantom target)
 *   - weight_mismatch    : same metric, different weight, not recorded as an accepted divergence
 *   - inconsistent_weight: a single metric declared with conflicting weights in production
 *
 * Findings are empty when the surfaces agree (or every asymmetry is allowlisted) — which is
 * exactly the property the parity unit test and the Eval-Production-Parity tripwire assert.
 */
export function scanMetricParity(opts: ScanParityOptions = {}): ParityReport {
  const prodSurface =
    opts.productionSource !== undefined
      ? extractScorecardSurface({ source: opts.productionSource, label: 'collector.ts' })
      : extractScorecardSurface();
  const optimizer =
    opts.optimizerSource !== undefined
      ? extractOptimizerSurface({ source: opts.optimizerSource, label: 'multi-metric.ts' })
      : extractOptimizerSurface();
  const manifest = opts.manifest ?? loadParityManifest();

  const prod = prodSurface.metrics;
  const excluded = new Set(manifest.intentionalExclusions.map((e) => e.name));
  const acceptedWeights = new Map(manifest.acceptedWeightDivergences.map((d) => [d.name, d]));

  const prodByName = new Map(prod.map((m) => [m.name, m]));
  const optByName = new Map(optimizer.map((m) => [m.name, m]));

  const findings: ParityFinding[] = [...prodSurface.inconsistencies];

  for (const m of prod) {
    if (optByName.has(m.name) || excluded.has(m.name)) continue;
    findings.push({
      kind: 'only_in_production',
      metric: m.name,
      evidence: `measured/displayed but not an optimizer target — ${m.evidence}`,
    });
  }

  for (const m of optimizer) {
    if (prodByName.has(m.name)) continue;
    findings.push({
      kind: 'only_in_optimizer',
      metric: m.name,
      evidence: `optimizer target with no production collector — ${m.evidence}`,
    });
  }

  for (const m of prod) {
    const opt = optByName.get(m.name);
    if (!opt) continue;
    if (Math.abs(m.weight - opt.weight) <= WEIGHT_EPS) continue;
    const accepted = acceptedWeights.get(m.name);
    if (
      accepted &&
      Math.abs(accepted.scorecardWeight - m.weight) <= WEIGHT_EPS &&
      Math.abs(accepted.optimizerWeight - opt.weight) <= WEIGHT_EPS
    ) {
      continue; // locked, intentional divergence
    }
    findings.push({
      kind: 'weight_mismatch',
      metric: m.name,
      evidence: `weight ${m.weight} (${m.evidence}) ≠ ${opt.weight} (${opt.evidence})`,
    });
  }

  findings.sort((a, b) => a.metric.localeCompare(b.metric) || a.kind.localeCompare(b.kind));

  const unionNames = new Set<string>([...prodByName.keys(), ...optByName.keys()]);
  const flagged = new Set(findings.map((f) => f.metric));
  const aligned = [...unionNames].filter((n) => !flagged.has(n)).length;

  return {
    productionCount: prod.length,
    optimizerCount: optimizer.length,
    declared: unionNames.size,
    aligned,
    findings,
  };
}
