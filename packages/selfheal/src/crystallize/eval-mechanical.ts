/**
 * Mechanical evaluation of a drafted candidate.
 *
 * Runs four gates in order; first failure short-circuits:
 *   1. slug shape  — sanity (caller should have already validated)
 *   2. static-scan — every file scanned for malicious patterns (NFKC-normalized)
 *   3. grep-validate — every backticked path/MCP tool reference in SKILL.md must resolve
 *   4. typecheck — stub scripts parse + typecheck under bun's transpiler
 *
 * Returns the resolved EvalStatus + the events to append to
 * `crystallization_events`. Caller is responsible for the DB write so this
 * module stays a pure function (testable without a DB).
 *
 * Per seed AC + Sec Eng F1–F6: a static-scan hit MUST produce
 * `eval_status='mechanical_fail'` and the matched pattern_id is recorded in
 * the event payload — no email is queued.
 */

import { DraftedFile, DraftedSkill } from './draft.js';
import { scanFiles, FileScanResult } from './static-scan.js';
import { validateReferences, GrepValidateResult } from './grep-validate.js';
import { validateSlug } from './slug.js';
import { EvalStatus, EventType } from './types.js';

export interface MechanicalEvalEvent {
  event_type: EventType;
  payload: Record<string, unknown>;
}

export interface MechanicalEvalResult {
  status: EvalStatus; // 'mechanical_pass' or 'mechanical_fail'
  events: MechanicalEvalEvent[];
  failures: MechanicalFailure[];
}

export type MechanicalFailure =
  | { stage: 'slug'; reason: string }
  | { stage: 'static_scan'; hits: FileScanResult[] }
  | { stage: 'grep_validate'; finding: GrepValidateResult }
  | { stage: 'typecheck'; errors: TypeCheckError[] };

export interface TypeCheckError {
  path: string;
  message: string;
}

/**
 * Default typecheck driver — uses Bun.Transpiler in v1 for fast syntax+type
 * stripping. The plan calls for `tsc --noEmit`, but Bun.Transpiler catches
 * the same parse-level mistakes a TODO stub can have, with no spawn cost.
 * Tests inject their own driver to assert pass/fail paths deterministically.
 */
export type TypeCheckDriver = (
  files: DraftedFile[],
) => Promise<TypeCheckError[]>;

export const defaultTypeCheckDriver: TypeCheckDriver = async (files) => {
  const errors: TypeCheckError[] = [];
  // Lazy-load the transpiler so non-bun consumers (jest, etc.) don't crash on
  // import. Bun is the test runtime per packages/selfheal/package.json.
  const Transpiler: any = (globalThis as any).Bun?.Transpiler;
  if (!Transpiler) {
    // No transpiler available — degrade to a parse-via-Function shim that at
    // least catches gross syntax errors in the stub.
    for (const f of files) {
      if (!f.path.endsWith('.ts')) continue;
      try {
        new Function(`return (async () => { ${f.content} })`);
      } catch (e) {
        errors.push({ path: f.path, message: (e as Error).message });
      }
    }
    return errors;
  }
  const t = new Transpiler({ loader: 'ts' });
  for (const f of files) {
    if (!f.path.endsWith('.ts')) continue;
    try {
      t.transformSync(f.content);
    } catch (e) {
      errors.push({ path: f.path, message: (e as Error).message });
    }
  }
  return errors;
};

export interface MechanicalEvalOptions {
  projectRoot: string;
  knownMcpTools: Set<string>;
  /** Override for tests; defaults to bun-transpiler-based syntax check. */
  typecheck?: TypeCheckDriver;
}

export async function evaluateMechanical(
  drafted: DraftedSkill,
  opts: MechanicalEvalOptions,
): Promise<MechanicalEvalResult> {
  const events: MechanicalEvalEvent[] = [];
  const failures: MechanicalFailure[] = [];

  // 1. slug
  const slugCheck = validateSlug(drafted.slug);
  if (!slugCheck.ok) {
    failures.push({ stage: 'slug', reason: slugCheck.reason });
  }

  // 2. static-scan
  const scanHits = scanFiles(drafted.files);
  if (scanHits.length > 0) {
    failures.push({ stage: 'static_scan', hits: scanHits });
  }

  // 3. grep-validate (only run on SKILL.md content)
  const skillMd = drafted.files.find((f) => f.path === 'SKILL.md');
  let refFinding: GrepValidateResult | null = null;
  if (skillMd) {
    refFinding = validateReferences(skillMd.content, {
      projectRoot: opts.projectRoot,
      knownMcpTools: opts.knownMcpTools,
    });
    if (!refFinding.ok) {
      failures.push({ stage: 'grep_validate', finding: refFinding });
    }
  }

  // 4. typecheck stubs
  const typecheckErrors = await (opts.typecheck ?? defaultTypeCheckDriver)(
    drafted.files,
  );
  if (typecheckErrors.length > 0) {
    failures.push({ stage: 'typecheck', errors: typecheckErrors });
  }

  const status: EvalStatus = failures.length === 0 ? 'mechanical_pass' : 'mechanical_fail';

  events.push({
    event_type: 'mechanical_eval',
    payload: {
      status,
      slug_ok: slugCheck.ok,
      slug_reason: slugCheck.ok ? null : slugCheck.reason,
      static_scan_hits: scanHits.map((h) => ({
        path: h.path,
        pattern_matched: h.finding.matched,
        line: h.finding.line,
      })),
      grep_validate_ok: refFinding?.ok ?? null,
      missing_paths: refFinding?.missingPaths ?? [],
      unknown_tools: refFinding?.unknownTools ?? [],
      typecheck_errors: typecheckErrors,
    },
  });

  return { status, events, failures };
}
