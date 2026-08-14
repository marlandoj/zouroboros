#!/usr/bin/env bun
/**
 * Standalone runner for the calibrated competence boundary (ZOU-281, #4).
 *
 * The reachable integration surface between the consensus-gate skill (Skills/consensus-gate,
 * out of process / not CI-gated) and the CI-tested calibration library in
 * calibration/competence-band.ts. The skill invokes this after producing a verdict to learn
 * whether the domain has enough history for vendor disagreement to be meaningful, then folds
 * the returned band into how confidently it dispatches.
 *
 * Lives under standalone/ (tsc-excluded, like holdout-eval.ts) — it is an executable entry,
 * not part of the typed library surface — but it IS scanned by the Wiring Sentinel reference
 * graph, so importing the library functions here is what marks them reachable.
 *
 * Input (any one of):
 *   --result '<json>'       a full ConsensusResult object; domain taken from .criteria, raw
 *                           disagreement from .consensus. Or pipe the same JSON on stdin.
 *   --domain <key> [--disagreement <0..1> | --confidence <0..1> | --unanimous]
 *                           compute directly without a result object.
 * Options:
 *   --history <path>        override the consensus history file (else CONSENSUS_GATE_DB or
 *                           ~/.zouroboros/consensus-gate.json).
 *   --json                  emit only the augmented JSON (no human line on stderr).
 *
 * Output (stdout): when --result was given, the original object with a `competence` field
 * added; otherwise the bare CompetenceReport. A one-line human summary goes to stderr unless
 * --json.
 */

import {
  calibrateConsensusDecision,
  computeCompetenceBand,
  countDomainHistory,
  disagreementFromConsensus,
  loadConsensusHistory,
  formatCompetenceReport,
  type ConsensusLike,
  type CompetenceReport,
} from '../calibration/competence-band.js';

interface Args {
  result?: string;
  domain?: string;
  disagreement?: string;
  confidence?: string;
  unanimous?: boolean;
  history?: string;
  json?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--result': args.result = argv[++i]; break;
      case '--domain': args.domain = argv[++i]; break;
      case '--disagreement': args.disagreement = argv[++i]; break;
      case '--confidence': args.confidence = argv[++i]; break;
      case '--unanimous': args.unanimous = true; break;
      case '--history': args.history = argv[++i]; break;
      case '--json': args.json = true; break;
    }
  }
  return args;
}

function readStdin(): string {
  try {
    return readFileSyncFd(0);
  } catch {
    return '';
  }
}

// fs.readFileSync(0) reads stdin to EOF; isolated so the import stays at the top.
function readFileSyncFd(fd: number): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  return fs.readFileSync(fd, 'utf-8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Path A: a full ConsensusResult (flag or stdin) → annotate it with a competence field.
  let resultJson = args.result;
  if (!resultJson && !args.domain) {
    const piped = readStdin().trim();
    if (piped) resultJson = piped;
  }

  if (resultJson) {
    let parsed: ConsensusLike & Record<string, unknown>;
    try {
      parsed = JSON.parse(resultJson);
    } catch (err) {
      console.error(`calibrate-consensus: invalid --result JSON: ${(err as Error).message}`);
      process.exit(2);
    }
    const domain = (parsed.criteria ?? parsed.label ?? 'unlabeled').toString();
    const report = calibrateConsensusDecision(domain, parsed.consensus, {
      historyPath: args.history,
    });
    emit({ ...parsed, competence: report }, report, args.json);
    return;
  }

  // Path B: direct domain + disagreement/confidence/unanimous.
  if (!args.domain) {
    console.error(
      'calibrate-consensus: provide --result <json> (or stdin) or --domain <key>. See header for usage.'
    );
    process.exit(2);
  }

  let raw: number;
  if (args.unanimous) {
    raw = 0;
  } else if (args.disagreement !== undefined) {
    raw = Number(args.disagreement);
  } else if (args.confidence !== undefined) {
    raw = disagreementFromConsensus({ unanimous: false, confidence: Number(args.confidence) });
  } else {
    raw = 1; // no signal given and not unanimous → maximally uncertain
  }

  const records = loadConsensusHistory(args.history);
  const n = countDomainHistory(records, args.domain);
  const report = computeCompetenceBand(args.domain, n, raw);
  emit(report, report, args.json);
}

function emit(payload: unknown, report: CompetenceReport, jsonOnly?: boolean): void {
  if (!jsonOnly) console.error(formatCompetenceReport(report));
  console.log(JSON.stringify(payload, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`calibrate-consensus: ${(err as Error).message}`);
    process.exit(1);
  });
}
