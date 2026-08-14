/**
 * Triage layer — cut false positives from heuristic-source findings.
 *
 * Two passes, each independently switchable:
 *
 *   1. Reproduce (deterministic, free, always-on with --triage)
 *      For each finding from a `production-ready:*-grep` source, re-read the
 *      surrounding context and check for obvious FP signals:
 *        - line is inside a comment
 *        - match is inside a regex literal (skill matching its own rules)
 *        - match is inside a description/message/title string property
 *
 *   2. Consensus (--triage --consensus; calls OpenAI + Anthropic)
 *      For findings that survive reproduce AND are from heuristic sources at
 *      severity >= medium, ask two vendors to vote real-vs-FP given the file
 *      context. Both-agree-real keeps; both-agree-FP drops; disagree → downgrade
 *      one tier and mark needsHumanReview.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Severity } from "./types.ts";

export type TriageDecision = "kept" | "downgraded" | "dropped" | "needs-review";

export interface VendorVote {
  verdict: "real" | "fp" | "uncertain";
  confidence: number;
  rationale: string;
}

export interface TriagedFinding extends Finding {
  triage?: {
    decision: TriageDecision;
    reproduce: { fpSignal: string | null };
    consensus?: {
      votes: Record<string, VendorVote | null>;
      tally: { real: number; fp: number; uncertain: number; missing: number };
      quorum: "real" | "fp" | "split";
    };
    originalSeverity: Severity;
  };
}

interface TriageOptions {
  consensus: boolean;
  repoPath?: string;
  /** Concurrency for consensus API calls */
  concurrency?: number;
}

const HEURISTIC_SOURCE_PREFIX = "production-ready:";
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function downgradeOne(s: Severity): Severity {
  const i = SEVERITY_ORDER.indexOf(s);
  return SEVERITY_ORDER[Math.min(i + 1, SEVERITY_ORDER.length - 1)];
}

function isHeuristicSource(source: string): boolean {
  return source.startsWith(HEURISTIC_SOURCE_PREFIX);
}

// ─── Reproduce pass ────────────────────────────────────────────────

/**
 * Cheap deterministic check: read window around the finding's evidence file/line
 * and look for FP signals.
 */
/**
 * Rule IDs whose entire purpose is to MATCH comments. The comment-FP signal
 * must not apply to these — their target IS a comment.
 */
const COMMENT_TARGETED_RULES = [
  /^ai-code\.commented-auth\./,
  /^ai-code\.if-false-security\./,    // matches "if False:" which is code, but rule reads commented-out logic
  /^ai-code\.skipped-test\./,
  /^legal\./,                          // legal-doc absence checks aren't line-specific
];

function isCommentTargeted(findingId: string): boolean {
  return COMMENT_TARGETED_RULES.some((re) => re.test(findingId));
}

function reproduceCheck(f: Finding, repoPath: string | undefined): { fpSignal: string | null } {
  const ev = f.evidence?.[0];
  if (!ev?.file || !ev?.line) return { fpSignal: null };
  const fullPath = repoPath && !ev.file.startsWith("/") ? join(repoPath, ev.file) : ev.file;
  if (!existsSync(fullPath)) return { fpSignal: null };

  let content: string;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    return { fpSignal: null };
  }
  const lines = content.split("\n");
  const idx = ev.line - 1;
  if (idx < 0 || idx >= lines.length) return { fpSignal: null };

  const line = lines[idx];
  const before = lines.slice(Math.max(0, idx - 3), idx).join("\n");
  const trimmed = line.trimStart();
  const commentTargeted = isCommentTargeted(f.id);

  // Signal 1: single-line comment (skip if rule targets comments by design)
  if (!commentTargeted && /^(\/\/|#|\*|--)/.test(trimmed)) {
    return { fpSignal: "line is a comment" };
  }
  // Signal 2: inside a block comment
  if (!commentTargeted) {
    const opens = (before.match(/\/\*/g) ?? []).length;
    const closes = (before.match(/\*\//g) ?? []).length;
    if (opens > closes) {
      return { fpSignal: "line is inside a block comment" };
    }
  }
  // Signal 3: match appears inside a regex literal (`/pattern/flags`)
  // Heuristic: the line contains `/.../` enclosing the matched substring or `pattern:` followed by `/.../`
  if (/(?:pattern|regex|expected|match)\s*[:=]\s*\//.test(line) || /\/[^/\n]{4,}\/[gimsuy]*/.test(line) && /matchAll|test|match|exec|replace/.test(line) === false) {
    // Stronger check: if the line defines a regex literal directly, it's likely the rule itself
    if (/\/[^/\n]{6,}\/[gimsuy]*/.test(line)) {
      return { fpSignal: "match inside regex literal (rule definition)" };
    }
  }
  // Signal 4: match inside a description/message/title/remediation string property
  if (/(description|message|title|remediation|rationale|name)\s*:\s*['"`]/.test(line) || /(description|message|title|remediation|rationale|name)\s*:\s*\[/.test(line)) {
    return { fpSignal: "match inside a string property (likely doc/report copy)" };
  }
  // Signal 5: line is a markdown bullet or heading (when scanning .md / .mdx)
  if (/\.(md|mdx)$/i.test(ev.file) && /^(#|-|\*|>)/.test(trimmed)) {
    return { fpSignal: "match in markdown documentation" };
  }
  // Signal 6: line contains a "rule.id" or "test" prefix indicating itself is a detection rule
  if (/\b(rule|check|finding|antipattern)[Ii]?d?\s*[:=]/.test(line)) {
    return { fpSignal: "match inside a rule/check definition" };
  }

  return { fpSignal: null };
}

// ─── Consensus pass (synthetic.new 3-vendor quorum) ──────────────

const SYNTHETIC_API = "https://api.synthetic.new/openai/v1/chat/completions";

/**
 * Default vendor models routed through synthetic.new. Three distinct architectures
 * to avoid correlated failure modes. Override via PRODUCTION_READY_VENDORS env
 * (comma-separated model ids).
 */
/**
 * Three non-reasoning instruct models from distinct families.
 * Reasoning models (GLM-5.1, Kimi-K2.6) were tried first but exhaust their
 * token budget on hidden chain-of-thought before emitting content. These
 * three return clean JSON in <1k tokens.
 */
const DEFAULT_VENDORS = [
  "hf:openai/gpt-oss-120b",
  "hf:meta-llama/Llama-3.3-70B-Instruct",
  "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
];

function resolveVendors(): string[] {
  const override = process.env.PRODUCTION_READY_VENDORS;
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_VENDORS;
}

const TRIAGE_SYSTEM = 'You triage static-analysis findings. Respond ONLY with a single JSON object on one line: {"verdict": "real" | "fp" | "uncertain", "confidence": 0..1, "rationale": "<one sentence>"}. No prose, no code fences.';

function parseVote(raw: string): VendorVote | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  // Extract first {...} block in case the model wrapped it in prose
  const match = cleaned.match(/\{[\s\S]*?\}/);
  const json = match ? match[0] : cleaned;
  try {
    const parsed = JSON.parse(json);
    if (!parsed.verdict || !["real", "fp", "uncertain"].includes(parsed.verdict)) return null;
    return {
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch {
    return null;
  }
}

async function askSyntheticVendor(model: string, prompt: string): Promise<VendorVote | null> {
  const key = process.env.SYNTHETIC_NEW_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(SYNTHETIC_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: TRIAGE_SYSTEM },
          { role: "user", content: prompt },
        ],
        max_tokens: 1024,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const msg = j?.choices?.[0]?.message;
    const raw = (msg?.content ?? msg?.reasoning_content ?? j?.output ?? "").toString();
    return parseVote(raw);
  } catch {
    return null;
  }
}

function buildVendorPrompt(f: Finding, contextSnippet: string): string {
  return [
    `Finding rule: ${f.title}`,
    `Severity claimed: ${f.severity}`,
    `Description: ${f.description}`,
    `Detection source: ${f.source}`,
    ``,
    `Code context (file ${f.evidence?.[0]?.file ?? "?"}, line ${f.evidence?.[0]?.line ?? "?"}):`,
    "```",
    contextSnippet,
    "```",
    ``,
    `Is this finding a real production-readiness issue in the code shown, or a false positive (rule matched documentation, a comment, a regex literal, or the rule's own definition)?`,
  ].join("\n");
}

function readContextWindow(f: Finding, repoPath: string | undefined): string {
  const ev = f.evidence?.[0];
  if (!ev?.file || !ev?.line) return "";
  const fullPath = repoPath && !ev.file.startsWith("/") ? join(repoPath, ev.file) : ev.file;
  if (!existsSync(fullPath)) return "";
  try {
    const lines = readFileSync(fullPath, "utf8").split("\n");
    const start = Math.max(0, ev.line - 6);
    const end = Math.min(lines.length, ev.line + 5);
    return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  } catch {
    return "";
  }
}

async function consensusCheck(
  f: Finding,
  repoPath: string | undefined,
): Promise<NonNullable<NonNullable<TriagedFinding["triage"]>["consensus"]>> {
  const context = readContextWindow(f, repoPath);
  const prompt = buildVendorPrompt(f, context);
  const vendors = resolveVendors();
  const results = await Promise.all(vendors.map((m) => askSyntheticVendor(m, prompt)));
  const votes: Record<string, VendorVote | null> = {};
  vendors.forEach((m, i) => (votes[m] = results[i]));
  const tally = { real: 0, fp: 0, uncertain: 0, missing: 0 };
  for (const v of results) {
    if (!v) tally.missing++;
    else if (v.verdict === "real") tally.real++;
    else if (v.verdict === "fp") tally.fp++;
    else tally.uncertain++;
  }
  let quorum: "real" | "fp" | "split" = "split";
  if (tally.real >= 2) quorum = "real";
  else if (tally.fp >= 2) quorum = "fp";
  return { votes, tally, quorum };
}

// ─── Orchestrator ──────────────────────────────────────────────────

export async function triageFindings(findings: Finding[], opts: TriageOptions): Promise<{
  kept: TriagedFinding[];
  dropped: TriagedFinding[];
  stats: { input: number; kept: number; downgraded: number; dropped: number; needsReview: number; consensusCalls: number };
}> {
  const kept: TriagedFinding[] = [];
  const dropped: TriagedFinding[] = [];
  const stats = { input: findings.length, kept: 0, downgraded: 0, dropped: 0, needsReview: 0, consensusCalls: 0 };

  // 1. Reproduce pass on every heuristic-source finding
  const consensusQueue: TriagedFinding[] = [];

  for (const orig of findings) {
    const f: TriagedFinding = { ...orig };
    if (!isHeuristicSource(f.source)) {
      // Tool-sourced (gitleaks, semgrep, osv-scanner) — trust it, no triage
      kept.push(f);
      stats.kept++;
      continue;
    }
    const repro = reproduceCheck(f, opts.repoPath);
    f.triage = {
      decision: "kept",
      reproduce: repro,
      originalSeverity: f.severity,
    };
    if (repro.fpSignal) {
      // Reproduce signaled FP — drop unconditionally
      f.triage.decision = "dropped";
      dropped.push(f);
      stats.dropped++;
      continue;
    }
    // Survives reproduce — queue for consensus if requested and severity warrants
    if (opts.consensus && (f.severity === "critical" || f.severity === "high" || f.severity === "medium")) {
      consensusQueue.push(f);
    } else {
      kept.push(f);
      stats.kept++;
    }
  }

  // 2. Consensus pass (parallel with concurrency limit)
  if (opts.consensus && consensusQueue.length > 0) {
    const conc = opts.concurrency ?? 4;
    for (let i = 0; i < consensusQueue.length; i += conc) {
      const batch = consensusQueue.slice(i, i + conc);
      await Promise.all(
        batch.map(async (f) => {
          const cons = await consensusCheck(f, opts.repoPath);
          stats.consensusCalls++;
          f.triage!.consensus = cons;
          const total = Object.keys(cons.votes).length;
          const responded = total - cons.tally.missing;
          // Inconclusive: fewer than 2 vendors responded — keep at original severity.
          // Missing votes are not evidence of ambiguity; quorum requires a real vote.
          if (responded < 2) {
            f.triage!.decision = "kept";
            kept.push(f);
            stats.kept++;
            return;
          }
          if (cons.quorum === "fp") {
            f.triage!.decision = "dropped";
            dropped.push(f);
            stats.dropped++;
          } else if (cons.quorum === "real") {
            f.triage!.decision = "kept";
            kept.push(f);
            stats.kept++;
          } else {
            // Genuine split among responders (e.g., 1 real / 1 fp / 1 missing)
            f.severity = downgradeOne(f.severity);
            f.triage!.decision = "needs-review";
            kept.push(f);
            stats.downgraded++;
            stats.needsReview++;
          }
        }),
      );
    }
  }

  return { kept, dropped, stats };
}
