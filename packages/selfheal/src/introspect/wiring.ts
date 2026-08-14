/**
 * Wiring Sentinel (seed-antigoodhart-wiring-2026-06-01, E2).
 *
 * Promotes the manual gap-audit's reachability / data-prerequisite / trigger-wiring
 * checks into a MECHANICAL signal. It detects three failure classes the loop has
 * historically only caught by hand:
 *   - unreachable     : an exported callable with zero inbound references in the
 *                       program (excluding the manifest's dynamicEntrypoints allowlist).
 *   - empty_store     : a declared data prerequisite whose store exists but is empty.
 *   - unbound_trigger : a declared trigger binding whose expected caller does not resolve.
 *   - broken_path_ref : a path literal in source that points at a file that does not exist
 *                       (e.g. the live evolve.ts:21 / playbook.ts:160 phantom
 *                       Skills/zouroboros-introspect/ references).
 *   - unread_env      : the 'env vars die at process boundaries' class (ZOU-278) — a value
 *                       SET via process.env.X = … that nothing in the scanned source READS.
 *   - half_wired_sentinel : a declared file-sentinel handoff written-but-never-read, or
 *                       read-but-never-written — cross-process state with only one end wired.
 *
 * Design constraints (seed): REPORT-and-ESCALATE only, never auto-delete — static
 * analysis is false-positive-prone in dynamic-dispatch / plugin / agent architectures,
 * so legitimately-dynamic capabilities are exempted via wiring-manifest.json and any
 * repair playbook is requiresApproval=true.
 *
 * tsc note: this file is type-checked (src/introspect/). It uses the already-installed
 * `typescript` compiler API for the reference graph (no new dep) and native `bun:sqlite`
 * for store checks (Bun is a hard runtime dependency of this package).
 */

import ts from 'typescript';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, isAbsolute, join, relative } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';

const WORKSPACE = getWorkspaceRoot();

export type WiringKind =
  | 'unreachable'
  | 'empty_store'
  | 'unbound_trigger'
  | 'broken_path_ref'
  | 'unread_env'
  | 'half_wired_sentinel';

export interface WiringFinding {
  kind: WiringKind;
  /** The exported callable / store / caller / path literal implicated. */
  symbol: string;
  /** file:line or query result proving the defect. */
  evidence: string;
}

export interface DataPrerequisite {
  capability: string;
  /** SQLite path (absolute or workspace-relative). */
  store: string;
  /** COUNT-style query; a result of 0 means the store is empty. */
  query: string;
}

export interface TriggerBinding {
  capability: string;
  /** File path (absolute or workspace-relative) that must resolve on disk. */
  expectedCaller: string;
}

export interface SentinelHandoff {
  capability: string;
  /**
   * A string fragment of the sentinel path that appears verbatim in code (e.g. the
   * workspace-relative path or filename passed to writeFileSync/readFileSync). Matching by
   * fragment — not exact equality — keeps the check robust to computed paths like
   * `join(WORKSPACE, '.zo/x.sentinel')`, whose literal `'.zo/x.sentinel'` still appears in
   * the AST. A handoff is healthy only when BOTH a writer and a reader reference it.
   */
  pathFragment: string;
}

export interface WiringManifest {
  dynamicEntrypoints: string[];
  dataPrerequisites: DataPrerequisite[];
  triggerBindings: TriggerBinding[];
  /**
   * Env var names that ARE legitimately consumed across a process boundary (set here, read
   * by a spawned child / sibling process the src/ reference graph cannot see). Suppresses
   * the unread_env false positive — the cross-process analogue of dynamicEntrypoints.
   */
  crossProcessExports: string[];
  /** Declared file-sentinel handoffs that must have both a writer and a reader in source. */
  sentinelHandoffs: SentinelHandoff[];
}

export interface WiringReport {
  /** Declared capabilities = callable exports + data prerequisites + trigger bindings. */
  declared: number;
  /** Declared minus the capability-level defects (unreachable + empty_store + unbound_trigger). */
  wired: number;
  findings: WiringFinding[];
}

const EMPTY_MANIFEST: WiringManifest = {
  dynamicEntrypoints: [],
  dataPrerequisites: [],
  triggerBindings: [],
  crossProcessExports: [],
  sentinelHandoffs: [],
};

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  noEmit: true,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  resolveJsonModule: true,
};

/**
 * Workspace-rooted prefixes a path literal must start with to be reachability-checked.
 * Extensions are ordered longest-first and bounded by a (?![A-Za-z0-9]) lookahead so a
 * `.json` ref is not truncated to `.js` (js is a prefix of json in the alternation) and a
 * `.tsx` ref is not truncated to `.ts`. Truncated extensions resolve to phantom paths and
 * were the dominant broken_path_ref false-positive source.
 */
const PATH_REF_REGEX =
  /(?:Skills|packages|scripts|Seeds|\.zo)\/[A-Za-z0-9._@/-]+\.(?:json|mjs|cjs|ts|js|py|sh)(?![A-Za-z0-9])/g;

function defaultSrcDir(): string {
  const fromWorkspace = join(WORKSPACE, 'packages/selfheal/src');
  if (existsSync(fromWorkspace)) return fromWorkspace;
  return fileURLToPath(new URL('../', import.meta.url));
}

/**
 * Derive the workspace root from the resolved src dir (<root>/packages/selfheal/src),
 * not from cwd: getWorkspaceRoot() falls back to process.cwd(), which is wrong when a
 * tool is invoked from inside the package. Path-ref resolution must anchor on the real
 * root or it false-flags every workspace-relative reference.
 */
function defaultProjectRoot(srcDir: string): string {
  const derived = join(srcDir, '..', '..', '..');
  if (existsSync(join(derived, 'packages/selfheal'))) return derived;
  return WORKSPACE;
}

export function loadWiringManifest(manifestPath?: string): WiringManifest {
  const path = manifestPath ?? join(defaultSrcDir(), 'introspect/wiring-manifest.json');
  if (!existsSync(path)) return { ...EMPTY_MANIFEST };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WiringManifest>;
    return {
      dynamicEntrypoints: parsed.dynamicEntrypoints ?? [],
      dataPrerequisites: parsed.dataPrerequisites ?? [],
      triggerBindings: parsed.triggerBindings ?? [],
      crossProcessExports: parsed.crossProcessExports ?? [],
      sentinelHandoffs: parsed.sentinelHandoffs ?? [],
    };
  } catch {
    return { ...EMPTY_MANIFEST };
  }
}

/** Recursively collect production .ts files (skip tests, declarations, build output). */
export function collectSourceFiles(srcDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

function declNodeKey(node: ts.Node): string {
  return `${node.getSourceFile().fileName}#${node.getStart()}`;
}

function resolvedDeclKey(checker: ts.TypeChecker, symbol: ts.Symbol): string | null {
  let sym = symbol;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* keep original on resolution failure */
    }
  }
  const decl = sym.declarations?.[0] ?? sym.valueDeclaration;
  return decl ? declNodeKey(decl) : null;
}

function isExported(stmt: ts.Statement): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

interface ExportInfo {
  name: string;
  file: string;
  line: number;
}

function collectCallableExports(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  out: Map<string, ExportInfo>
): void {
  const add = (nameNode: ts.Identifier) => {
    const sym = checker.getSymbolAtLocation(nameNode);
    const key = sym ? resolvedDeclKey(checker, sym) : declNodeKey(nameNode.parent);
    if (!key) return;
    const line = sf.getLineAndCharacterOfPosition(nameNode.getStart()).line + 1;
    out.set(key, { name: nameNode.text, file: sf.fileName, line });
  };

  for (const stmt of sf.statements) {
    if (!isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      add(stmt.name);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      add(stmt.name);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          add(decl.name);
        }
      }
    }
  }
}

function isDefiningOccurrence(node: ts.Identifier): boolean {
  const p = node.parent;
  const owners =
    ts.isFunctionDeclaration(p) ||
    ts.isClassDeclaration(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isBindingElement(p) ||
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p);
  return owners && (p as unknown as { name?: ts.Node }).name === node;
}

function collectUsedKeys(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  used: Set<string>
): void {
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !isDefiningOccurrence(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        const key = resolvedDeclKey(checker, sym);
        if (key) used.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

export interface ExportAnalysis {
  declaredCallables: number;
  unreachable: WiringFinding[];
}

export interface AnalyzeExportsOptions {
  srcDir?: string;
  projectRoot?: string;
  dynamicEntrypoints?: string[];
  files?: string[];
}

/**
 * Build a reference graph over the source tree with the TypeScript compiler API and
 * return exported callables (functions / classes / function-valued consts) that have
 * zero inbound references, excluding the manifest's dynamicEntrypoints allowlist.
 */
export function analyzeExports(opts: AnalyzeExportsOptions = {}): ExportAnalysis {
  const srcDir = opts.srcDir ?? defaultSrcDir();
  const projectRoot = opts.projectRoot ?? WORKSPACE;
  const allow = new Set(opts.dynamicEntrypoints ?? []);
  const files = opts.files ?? collectSourceFiles(srcDir);

  const program = ts.createProgram(files, COMPILER_OPTIONS);
  const checker = program.getTypeChecker();

  const exportsByKey = new Map<string, ExportInfo>();
  const usedKeys = new Set<string>();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    collectCallableExports(sf, checker, exportsByKey);
  }
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    collectUsedKeys(sf, checker, usedKeys);
  }

  const unreachable: WiringFinding[] = [];
  for (const [key, info] of exportsByKey) {
    if (usedKeys.has(key)) continue;
    const rel = relative(projectRoot, info.file);
    if (allow.has(info.name) || allow.has(`${rel}:${info.name}`)) continue;
    unreachable.push({
      kind: 'unreachable',
      symbol: info.name,
      evidence: `${rel}:${info.line}`,
    });
  }
  unreachable.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { declaredCallables: exportsByKey.size, unreachable };
}

/** Thin wrapper returning just the unreachable findings (AC-E2.1). */
export function findUnreachableExports(opts: AnalyzeExportsOptions = {}): WiringFinding[] {
  return analyzeExports(opts).unreachable;
}

export interface BrokenPathRefOptions {
  files?: string[];
  srcDir?: string;
  projectRoot?: string;
}

interface PathRefHit {
  ref: string;
  line: number;
}

/**
 * Extract workspace-rooted path refs that appear inside STRING LITERALS only (parsed via
 * the TS scanner). Restricting to string literals skips path-shaped examples in doc
 * comments — a real path dependency is virtually always a string literal, while the
 * historical false positives were illustrative paths in JSDoc.
 */
function extractStringLiteralRefs(file: string, text: string): PathRefHit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, /*setParentNodes*/ true);
  const hits: PathRefHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      PATH_REF_REGEX.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_REF_REGEX.exec(node.text)) !== null) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push({ ref: m[0], line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Scan source files for workspace-rooted path literals that do not resolve on disk
 * (AC-E2.3). Catches the live evolve.ts:21 and playbook.ts:160 phantom references.
 *
 * Two false-positive guards keep the signal trustworthy (report-and-escalate must not be
 * noisy): refs are read only from string literals (not comments), and a missing ref is
 * suppressed when a same-basename sibling ref in the SAME file resolves on disk — that is
 * the graceful multi-location fallback-candidate pattern (e.g. holdout.ts RUNNER_CANDIDATES
 * listing monorepo + runtime-skill copies), not a defect.
 */
export function findBrokenPathRefs(opts: BrokenPathRefOptions = {}): WiringFinding[] {
  const projectRoot = opts.projectRoot ?? WORKSPACE;
  const files = opts.files ?? collectSourceFiles(opts.srcDir ?? defaultSrcDir());
  const findings: WiringFinding[] = [];
  const seen = new Set<string>();

  const resolveRef = (ref: string) => (isAbsolute(ref) ? ref : join(projectRoot, ref));

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const hits = extractStringLiteralRefs(file, text);
    if (hits.length === 0) continue;

    const presentBasenames = new Set<string>();
    for (const { ref } of hits) {
      if (existsSync(resolveRef(ref))) presentBasenames.add(basename(ref));
    }

    const rel = relative(projectRoot, file);
    for (const { ref, line } of hits) {
      if (existsSync(resolveRef(ref))) continue;
      if (presentBasenames.has(basename(ref))) continue; // fallback-candidate sibling resolves
      const dedupe = `${rel}:${line}:${ref}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      findings.push({ kind: 'broken_path_ref', symbol: ref, evidence: `${rel}:${line}` });
    }
  }
  return findings;
}

/** True for a `process.env` member expression (the object you read keys off of). */
function isProcessEnvNode(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

/** The env key for `process.env.NAME` / `process.env['NAME']`, or null for a dynamic key. */
function envKeyOf(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** `process.env.NAME` appearing as the left side of a plain `=` assignment is a WRITE. */
function isEnvWriteTarget(access: ts.Node): boolean {
  const p = access.parent;
  return (
    !!p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.left === access
  );
}

interface EnvWriteSite {
  file: string;
  line: number;
}

export interface EnvWriteAnalysis {
  /** Distinct env var names written via `process.env.X =` (the denominator). */
  declaredWrites: number;
  /** Writes whose value is never read anywhere in the scanned source (minus allowlist). */
  unread: WiringFinding[];
}

export interface AnalyzeEnvWritesOptions {
  files?: string[];
  srcDir?: string;
  projectRoot?: string;
  crossProcessExports?: string[];
}

/**
 * Detect the 'env vars die at process boundaries' failure class (ZOU-278): a value SET via
 * `process.env.X = …` that nothing in the scanned source ever READS. The loop has only ever
 * caught this by hand — a capability that hands state to a downstream consumer that was never
 * wired up. Mirrors analyzeExports/unreachable, but over env keys instead of callable exports.
 *
 * False-positive discipline (report-and-escalate must stay trustworthy):
 *   - A BULK use of `process.env` (spread `{...process.env}`, `Object.keys(process.env)`,
 *     passing it whole to a child, a `...rest` destructure, or a dynamic `process.env[expr]`
 *     key) means any var COULD be consumed downstream → suppress ALL unread_env findings.
 *   - Names in `crossProcessExports` are deliberately exported to an out-of-process reader the
 *     src/ graph cannot see → never flagged (the cross-process analogue of dynamicEntrypoints).
 */
export function analyzeEnvWrites(opts: AnalyzeEnvWritesOptions = {}): EnvWriteAnalysis {
  const projectRoot = opts.projectRoot ?? WORKSPACE;
  const files = opts.files ?? collectSourceFiles(opts.srcDir ?? defaultSrcDir());
  const allow = new Set(opts.crossProcessExports ?? []);

  const writes = new Map<string, EnvWriteSite>();
  const reads = new Set<string>();
  let bulkRead = false;

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, /*setParentNodes*/ true);
    const visit = (node: ts.Node) => {
      // Named access: process.env.NAME or process.env['NAME']
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isProcessEnvNode(node.expression)
      ) {
        const key = envKeyOf(node);
        if (key === null) {
          bulkRead = true; // dynamic key process.env[expr] — unknowable, suppress
        } else if (isEnvWriteTarget(node)) {
          if (!writes.has(key)) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            writes.set(key, { file, line });
          }
        } else {
          reads.add(key);
        }
        ts.forEachChild(node, visit);
        return;
      }
      // Destructure: const { A, B, ...rest } = process.env
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isProcessEnvNode(node.initializer) &&
        ts.isObjectBindingPattern(node.name)
      ) {
        for (const el of node.name.elements) {
          if (el.dotDotDotToken) {
            bulkRead = true;
          } else {
            const src = el.propertyName ?? el.name;
            if (ts.isIdentifier(src)) reads.add(src.text);
          }
        }
        ts.forEachChild(node, visit);
        return;
      }
      // Any OTHER use of the process.env object (spread, passed whole, Object.keys, …) is bulk.
      if (isProcessEnvNode(node)) {
        const p = node.parent;
        const isNamedAccessParent =
          (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
          p.expression === node;
        const isDestructureParent =
          ts.isVariableDeclaration(p) && p.initializer === node && ts.isObjectBindingPattern(p.name);
        if (!isNamedAccessParent && !isDestructureParent) bulkRead = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const unread: WiringFinding[] = [];
  if (!bulkRead) {
    for (const [name, site] of writes) {
      if (reads.has(name) || allow.has(name)) continue;
      unread.push({
        kind: 'unread_env',
        symbol: name,
        evidence: `${relative(projectRoot, site.file)}:${site.line}`,
      });
    }
  }
  unread.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { declaredWrites: writes.size, unread };
}

/** Thin wrapper returning just the unread_env findings. */
export function findUnreadEnvWrites(opts: AnalyzeEnvWritesOptions = {}): WiringFinding[] {
  return analyzeEnvWrites(opts).unread;
}

const FS_WRITE_FNS = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'outputFileSync',
  'outputFile',
  'createWriteStream',
]);
const FS_READ_FNS = new Set([
  'readFileSync',
  'readFile',
  'existsSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'createReadStream',
  'accessSync',
]);

/** Simple callee name for `f(...)`, `ns.f(...)`, `await ns.sub.f(...)` → 'f'. */
function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** All string-literal texts appearing anywhere inside a node's subtree. */
function stringLiteralsIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

interface FragmentHit {
  file: string;
  line: number;
}

/**
 * Validate declared file-sentinel handoffs (ZOU-278): a sentinel path that is WRITTEN but
 * never READ (producer with no consumer) or READ but never WRITTEN (consumer with no
 * producer) is half-wired state — the file-sentinel analogue of the env boundary failure.
 * Declaration-driven (like dataPrerequisites / triggerBindings): only manifest-declared
 * handoffs are checked, so there are no inferred false positives. A fragment is matched
 * against the string literals passed to fs read/write calls, so computed paths resolve.
 */
export function checkSentinelHandoffs(
  handoffs: SentinelHandoff[],
  opts: BrokenPathRefOptions = {}
): WiringFinding[] {
  if (handoffs.length === 0) return [];
  const projectRoot = opts.projectRoot ?? WORKSPACE;
  const files = opts.files ?? collectSourceFiles(opts.srcDir ?? defaultSrcDir());

  const writers = new Map<string, FragmentHit>();
  const readers = new Map<string, FragmentHit>();

  const record = (
    map: Map<string, FragmentHit>,
    frag: string,
    file: string,
    line: number
  ) => {
    if (!map.has(frag)) map.set(frag, { file, line });
  };

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, /*setParentNodes*/ true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        const target = name && FS_WRITE_FNS.has(name) ? writers : name && FS_READ_FNS.has(name) ? readers : null;
        if (target) {
          const literals = node.arguments.flatMap((a) => stringLiteralsIn(a));
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          for (const h of handoffs) {
            if (literals.some((lit) => lit.includes(h.pathFragment))) {
              record(target, h.pathFragment, file, line);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const findings: WiringFinding[] = [];
  for (const h of handoffs) {
    const w = writers.get(h.pathFragment);
    const r = readers.get(h.pathFragment);
    if (w && r) continue;
    let evidence: string;
    if (w && !r) evidence = `written at ${relative(projectRoot, w.file)}:${w.line}, never read`;
    else if (r && !w) evidence = `read at ${relative(projectRoot, r.file)}:${r.line}, never written`;
    else evidence = `declared sentinel '${h.pathFragment}' has no writer and no reader in source`;
    findings.push({ kind: 'half_wired_sentinel', symbol: h.capability, evidence });
  }
  return findings;
}

/** Validate declared data prerequisites: store present but empty → empty_store (AC-E2.2). */
export function checkDataPrerequisites(
  prerequisites: DataPrerequisite[],
  projectRoot: string = WORKSPACE
): WiringFinding[] {
  const findings: WiringFinding[] = [];
  for (const pre of prerequisites) {
    const store = isAbsolute(pre.store) ? pre.store : join(projectRoot, pre.store);
    if (!existsSync(store)) continue; // unmeasurable in this environment → fail-safe, don't flag
    let count = -1;
    let db: Database | null = null;
    try {
      db = new Database(store, { readonly: true });
      const rows = db.query(pre.query).values() as unknown[][];
      const parsed = parseInt(String(rows[0]?.[0] ?? ''), 10);
      count = isNaN(parsed) ? -1 : parsed;
    } catch {
      count = -1;
    } finally {
      db?.close();
    }
    if (count === 0) {
      findings.push({
        kind: 'empty_store',
        symbol: pre.capability,
        evidence: `0 rows for "${pre.query}" in ${pre.store}`,
      });
    }
  }
  return findings;
}

/** Validate declared trigger bindings: expected caller missing → unbound_trigger (AC-E2.2). */
export function checkTriggerBindings(
  bindings: TriggerBinding[],
  projectRoot: string = WORKSPACE
): WiringFinding[] {
  const findings: WiringFinding[] = [];
  for (const binding of bindings) {
    const caller = isAbsolute(binding.expectedCaller)
      ? binding.expectedCaller
      : join(projectRoot, binding.expectedCaller);
    if (!existsSync(caller)) {
      findings.push({
        kind: 'unbound_trigger',
        symbol: binding.capability,
        evidence: `expected caller missing: ${binding.expectedCaller}`,
      });
    }
  }
  return findings;
}

export interface ScanWiringOptions {
  srcDir?: string;
  projectRoot?: string;
  manifest?: WiringManifest;
  manifestPath?: string;
}

/**
 * Full sentinel pass: reference graph + path refs + data prerequisites + trigger bindings.
 * `wired/declared` over capability-level defects is the score for measureWiringHealth;
 * broken_path_ref findings are surfaced in `findings` for the report/escalation path.
 */
export function scanWiring(opts: ScanWiringOptions = {}): WiringReport {
  const srcDir = opts.srcDir ?? defaultSrcDir();
  const projectRoot = opts.projectRoot ?? defaultProjectRoot(srcDir);
  const manifest = opts.manifest ?? loadWiringManifest(opts.manifestPath);
  const files = collectSourceFiles(srcDir);

  const { declaredCallables, unreachable } = analyzeExports({
    srcDir,
    projectRoot,
    dynamicEntrypoints: manifest.dynamicEntrypoints,
    files,
  });
  const broken = findBrokenPathRefs({ files, projectRoot });
  const empty = checkDataPrerequisites(manifest.dataPrerequisites, projectRoot);
  const unbound = checkTriggerBindings(manifest.triggerBindings, projectRoot);
  const { declaredWrites, unread } = analyzeEnvWrites({
    files,
    projectRoot,
    crossProcessExports: manifest.crossProcessExports,
  });
  const sentinels = checkSentinelHandoffs(manifest.sentinelHandoffs, { files, projectRoot });

  const declared =
    declaredCallables +
    manifest.dataPrerequisites.length +
    manifest.triggerBindings.length +
    declaredWrites +
    manifest.sentinelHandoffs.length;
  const capabilityDefects =
    unreachable.length + empty.length + unbound.length + unread.length + sentinels.length;
  const wired = Math.max(0, declared - capabilityDefects);

  return {
    declared,
    wired,
    findings: [...unreachable, ...broken, ...empty, ...unbound, ...unread, ...sentinels],
  };
}
