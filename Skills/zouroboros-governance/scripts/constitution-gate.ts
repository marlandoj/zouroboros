#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type ConstitutionPhase = "preflight" | "promotion";
export type BlastRadius = "tiny" | "local" | "shared" | "high";

export interface ConstitutionInput {
  operation: string;
  description: string;
  targetFiles: string[];
  modifiesModelWeights: boolean;
  reversible: boolean;
  rollbackPlan: string;
  blastRadius: BlastRadius;
  humanApproved: boolean;
  provenance: {
    rationale: string;
    evidence: string[];
    actor: string;
    traceId?: string;
  };
  budgetBounded: boolean;
  layerIntegrity: boolean;
  failClosed: boolean;
  verification?: {
    mechanical: boolean;
    heldOut: boolean;
    consensus: boolean;
    regressionFree: boolean;
  };
}

export interface ConstitutionViolation {
  article: string;
  code: string;
  message: string;
}

export interface DocumentVerification {
  ok: boolean;
  canonicalRoot: string;
  violations: ConstitutionViolation[];
  documents: Array<{
    name: string;
    canonicalPath: string;
    mirrorPath: string;
    sha256: string | null;
    mirrorMode: "symlink" | "identical-copy" | "missing" | "drifted";
  }>;
}

export interface ConstitutionDecision {
  decision: "ALLOW" | "BLOCK";
  phase: ConstitutionPhase;
  operation: string;
  checkedAt: string;
  violations: ConstitutionViolation[];
  documents: DocumentVerification;
}

const DEFAULT_CANONICAL_ROOT = "/home/workspace/zouroboros";
const DEFAULT_MIRROR_ROOT = "/home/workspace";
const GOVERNING_DOCUMENTS = ["ZOUROBOROS.md", "CONSTITUTION.md"] as const;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function violation(article: string, code: string, message: string): ConstitutionViolation {
  return { article, code, message };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function verifyCanonicalDocuments(options: {
  canonicalRoot?: string;
  mirrorRoot?: string;
} = {}): DocumentVerification {
  const canonicalRoot = options.canonicalRoot ?? DEFAULT_CANONICAL_ROOT;
  const mirrorRoot = options.mirrorRoot ?? DEFAULT_MIRROR_ROOT;
  const violations: ConstitutionViolation[] = [];
  const documents: DocumentVerification["documents"] = [];

  for (const name of GOVERNING_DOCUMENTS) {
    const canonicalPath = join(canonicalRoot, name);
    const mirrorPath = join(mirrorRoot, name);
    let canonicalContent: string | null = null;
    let mirrorMode: DocumentVerification["documents"][number]["mirrorMode"] = "missing";

    if (!existsSync(canonicalPath)) {
      violations.push(violation("Article X", "X-CANONICAL-MISSING", `Canonical document is missing: ${canonicalPath}`));
    } else {
      canonicalContent = readFileSync(canonicalPath, "utf8");
    }

    if (!existsSync(mirrorPath)) {
      violations.push(violation("Article X", "X-MIRROR-MISSING", `Workspace governance entry point is missing: ${mirrorPath}`));
    } else if (canonicalContent !== null) {
      const sameTarget = realpathSync(mirrorPath) === realpathSync(canonicalPath);
      const sameContent = readFileSync(mirrorPath, "utf8") === canonicalContent;
      mirrorMode = sameTarget ? "symlink" : sameContent ? "identical-copy" : "drifted";
      if (!sameTarget && !sameContent) {
        violations.push(violation("Article X", "X-DOCUMENT-DRIFT", `${mirrorPath} differs from canonical ${canonicalPath}`));
      }
    }

    documents.push({
      name,
      canonicalPath,
      mirrorPath,
      sha256: canonicalContent === null ? null : sha256(canonicalContent),
      mirrorMode,
    });
  }

  const constitutionPath = join(canonicalRoot, "CONSTITUTION.md");
  if (existsSync(constitutionPath)) {
    const constitution = readFileSync(constitutionPath, "utf8");
    const articles = constitution.match(/^## Article [IVX]+\b/gm) ?? [];
    if (articles.length !== 10) {
      violations.push(violation("Article X", "X-ARTICLE-SET", `Constitution must contain exactly 10 articles; found ${articles.length}`));
    }
  }

  const manifestoPath = join(canonicalRoot, "ZOUROBOROS.md");
  if (existsSync(manifestoPath)) {
    const manifesto = readFileSync(manifestoPath, "utf8");
    if (!/self[- ]evolving AI operating system/i.test(manifesto)) {
      violations.push(violation("Article X", "X-MANIFESTO-IDENTITY", "Manifesto is missing the canonical Zouroboros identity statement"));
    }
  }

  return { ok: violations.length === 0, canonicalRoot, violations, documents };
}

export function evaluateConstitution(
  rawInput: unknown,
  phase: ConstitutionPhase,
  options: { canonicalRoot?: string; mirrorRoot?: string } = {},
): ConstitutionDecision {
  const documents = verifyCanonicalDocuments(options);
  const violations = [...documents.violations];
  const input = rawInput as Partial<ConstitutionInput> | null;
  const operation = nonEmpty(input?.operation) ? input.operation.trim() : "unknown";

  if (!input || typeof input !== "object") {
    violations.push(violation("Article IX", "IX-INVALID-INPUT", "Constitution gate input must be a JSON object"));
  } else {
    if (!nonEmpty(input.operation) || !nonEmpty(input.description) || !Array.isArray(input.targetFiles)) {
      violations.push(violation("Article VI", "VI-INCOMPLETE-SCOPE", "Operation, description, and targetFiles are required for provenance"));
    }
    if (input.modifiesModelWeights !== false) {
      violations.push(violation("Article I", "I-FROZEN-WEIGHTS", "Self-modification may not train, fine-tune, or alter model weights"));
    }
    if (input.reversible !== true || !nonEmpty(input.rollbackPlan)) {
      violations.push(violation("Article IV", "IV-NO-ROLLBACK", "A concrete rollback plan and reversible=true are required"));
    }
    if ((input.blastRadius === "shared" || input.blastRadius === "high") && input.humanApproved !== true) {
      violations.push(violation("Article V", "V-HUMAN-AUTHORIZATION", "Shared or high-blast-radius change requires explicit human approval"));
    }
    if (
      !input.provenance ||
      !nonEmpty(input.provenance.rationale) ||
      !nonEmpty(input.provenance.actor) ||
      !Array.isArray(input.provenance.evidence) ||
      input.provenance.evidence.length === 0
    ) {
      violations.push(violation("Article VI", "VI-PROVENANCE", "Rationale, actor, and at least one evidence reference are required"));
    }
    if (input.budgetBounded !== true) {
      violations.push(violation("Article VII", "VII-UNBOUNDED-RESOURCES", "The operation must declare a bounded resource budget"));
    }
    if (input.layerIntegrity !== true) {
      violations.push(violation("Article VIII", "VIII-LAYER-INTEGRITY", "The operation must preserve model, harness, agent, memory, and control-plane boundaries"));
    }
    if (input.failClosed !== true) {
      violations.push(violation("Article IX", "IX-FAIL-OPEN", "The caller must stop when governance evidence is absent, invalid, or unavailable"));
    }

    const amendsGovernance = input.targetFiles?.some((file) => GOVERNING_DOCUMENTS.some((name) => file.endsWith(name))) ?? false;
    if (amendsGovernance && input.humanApproved !== true) {
      violations.push(violation("Article X", "X-AMENDMENT-AUTHORIZATION", "Manifesto or constitution amendments require explicit human approval"));
    }

    if (phase === "promotion") {
      const verification = input.verification;
      if (!verification || verification.mechanical !== true || verification.heldOut !== true || verification.consensus !== true) {
        violations.push(violation("Article II", "II-UNVERIFIED-PROMOTION", "Promotion requires passing mechanical, held-out, and consensus verification"));
      }
      if (!verification || verification.regressionFree !== true) {
        violations.push(violation("Article III", "III-REGRESSION-RISK", "Promotion requires held-out evidence that the change is regression-free"));
      }
    }
  }

  return {
    decision: violations.length === 0 ? "ALLOW" : "BLOCK",
    phase,
    operation,
    checkedAt: new Date().toISOString(),
    violations,
    documents,
  };
}

function auditDecision(decision: ConstitutionDecision): void {
  const governanceScript = join(dirname(fileURLToPath(import.meta.url)), "governance.ts");
  execFileSync(process.execPath, [
    governanceScript,
    "verdict",
    "--kind",
    "constitution-gate",
    "--label",
    `${decision.phase}:${decision.operation}`,
    "--verdict",
    decision.decision,
    "--evidence",
    JSON.stringify({ violations: decision.violations, documents: decision.documents.documents }),
    "--rationale",
    decision.decision === "ALLOW" ? "All applicable constitutional checks passed" : "One or more constitutional checks failed",
    "--json",
  ], { stdio: "ignore" });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runConstitutionGateCli(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      input: { type: "string" },
      stdin: { type: "boolean", default: false },
      phase: { type: "string", default: "preflight" },
      "canonical-root": { type: "string", default: DEFAULT_CANONICAL_ROOT },
      "mirror-root": { type: "string", default: DEFAULT_MIRROR_ROOT },
      "skip-audit": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? "help";
  const options = { canonicalRoot: values["canonical-root"], mirrorRoot: values["mirror-root"] };

  if (command === "verify-docs") {
    const result = verifyCanonicalDocuments(options);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command !== "check") {
    console.log("Usage: constitution-gate.ts verify-docs | check (--input '<json>' | --stdin) [--phase preflight|promotion] [--skip-audit]");
    return;
  }

  if (values.phase !== "preflight" && values.phase !== "promotion") {
    throw new Error(`Invalid phase '${values.phase}'. Expected preflight or promotion.`);
  }

  const source = values.stdin ? await readStdin() : values.input;
  if (!source) throw new Error("check requires --input or --stdin");
  const decision = evaluateConstitution(JSON.parse(source), values.phase, options);
  if (!values["skip-audit"]) auditDecision(decision);
  console.log(JSON.stringify(decision, null, 2));
  process.exitCode = decision.decision === "ALLOW" ? 0 : 2;
}

if (import.meta.main) {
  runConstitutionGateCli().catch((error) => {
    console.error(JSON.stringify({ decision: "BLOCK", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 2;
  });
}
