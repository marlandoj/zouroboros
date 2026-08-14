/**
 * Shared types for the production-ready audit.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Domain =
  | "legal"
  | "secrets"
  | "authentication"
  | "api-safety"
  | "owasp"
  | "abuse-rate"
  | "frontend"
  | "logging"
  | "accessibility"
  | "performance"
  | "payments"
  | "file-uploads"
  | "database"
  | "ai-code"
  | "browser-test"
  | "concurrency"
  | "visual-consistency"
  | "seo-aeo";

export type Verdict =
  | "launch-ready"
  | "launch-with-monitoring"
  | "private-beta-only"
  | "do-not-launch";

/**
 * Per-domain coverage status. A domain that could not be meaningfully
 * exercised (missing scanner, no URL, threw an error) is NOT the same as a
 * domain that ran clean. Verdicts must account for this — an audit that did
 * not actually inspect a concern can never certify it as launch-ready.
 */
export type CoverageStatus = "pass" | "partial" | "fail" | "not-run";

export interface DomainCoverage {
  status: CoverageStatus;
  /** Human-readable why, e.g. "gitleaks unavailable; regex-only" */
  reason?: string;
}

export interface Finding {
  /** Stable id, e.g. "secrets.frontend-key-leak.next_public" */
  id: string;
  domain: Domain;
  severity: Severity;
  /** One-line title for reports */
  title: string;
  /** Multi-line explanation in markdown */
  description: string;
  /** File:line evidence when available */
  evidence?: Array<{ file?: string; line?: number; snippet?: string; url?: string }>;
  /** Whether this is a "hard blocker" that forces Do Not Launch */
  hardBlocker?: boolean;
  /** Suggested fix, in markdown */
  remediation: string;
  /** A copy-paste prompt for a coding agent (Claude Code / Cursor / Aider) */
  agentPrompt?: string;
  /** OWASP / CWE / WCAG references */
  references?: string[];
  /** Which underlying tool surfaced this (e.g., "gitleaks", "semgrep:auth.bypass") */
  source: string;

  // ── Extended finding contract (all optional; older checks may omit) ──
  /** Business/user impact if left unfixed, in plain language. */
  impact?: string;
  /** Concrete steps to reproduce or observe the issue. */
  reproduction?: string;
  /**
   * How sure we are this is real vs. a heuristic guess.
   *  - high:      external scanner or unambiguous match (e.g. gitleaks hit)
   *  - medium:    strong in-process signal, low false-positive rate
   *  - low:       heuristic; may be a false positive, needs human confirm
   */
  confidence?: "high" | "medium" | "low";
  /**
   * Whether the finding was confirmed at runtime or is static/heuristic only.
   *  - verified:   observed live (e.g. Playwright saw the console error)
   *  - heuristic:  static pattern match, not runtime-confirmed
   *  - unverified: reported by a tool we could not independently corroborate
   */
  verificationStatus?: "verified" | "heuristic" | "unverified";
  /** The user-facing flow this touches, e.g. "checkout", "sign-in". */
  affectedFlow?: string;
  /**
   * Effort/shape of the fix, used to split quick wins from deep work.
   *  - quick-win:     minutes; config/flag/one-liner
   *  - config:        change deployment/build/env config
   *  - code-change:   localized code edit
   *  - architectural: cross-cutting redesign
   */
  remediationClass?: "quick-win" | "config" | "code-change" | "architectural";
}

export interface ManualCheckItem {
  item: string;
  rationale: string;
  /**
   * A critical manual check gates launch: it covers a concern automation
   * cannot verify (e.g. server-side auth gating observed in a browser). While
   * unverified, the audit cannot certify launch-ready.
   */
  critical?: boolean;
}

export interface CheckResult {
  domain: Domain;
  ranAt: string;
  durationMs: number;
  toolsUsed: string[];
  toolsMissing: string[];
  findings: Finding[];
  /** Items the check could not verify and that need human eyes */
  manualChecklist: ManualCheckItem[];
  /**
   * How completely this domain was actually audited. If omitted, the
   * coverage layer infers it from error/toolsUsed/toolsMissing.
   */
  coverage?: DomainCoverage;
  error?: string;
}

export interface AuditConfig {
  repoPath?: string;
  url?: string;
  outDir: string;
  format: "json" | "md" | "html" | "all";
  appName?: string;
  appPurpose?: string;
  techStack?: string[];
  deployment?: string;
  providers?: { auth?: string; db?: string; payments?: string };
  surfaces?: {
    userData?: boolean;
    uploads?: boolean;
    admin?: boolean;
    ai?: boolean;
    payments?: boolean;
  };
  only?: Domain[];
  skip?: Domain[];
  godmode?: boolean;
  failOn?: Severity;
  /**
   * Set when a human has signed off the critical manual checklist items.
   * Until then, the presence of unverified critical manual checks caps the
   * verdict below launch-ready.
   */
  manualVerified?: boolean;
  /** Loaded from --config; see references/audit-config-schema.md. */
  policy?: AuditPolicy;
}

/**
 * Declarative audit policy, loaded from a JSON config file via --config.
 * Matches references/audit-config-schema.md. All fields optional; absent
 * fields fall back to auto-detection / built-in defaults.
 */
export interface AuditPolicy {
  // ── Config defaults (merged into AuditConfig when not given on CLI) ──
  appName?: string;
  appPurpose?: string;
  techStack?: string[];
  deployment?: string;
  providers?: { auth?: string; db?: string; payments?: string };
  surfaces?: {
    userData?: boolean;
    uploads?: boolean;
    admin?: boolean;
    ai?: boolean;
    payments?: boolean;
  };
  url?: string;

  // ── Suppression ──
  ignore?: {
    /** Skip these check domains entirely. */
    domains?: Domain[];
    /** Suppress findings with these exact ids (or substring match). */
    findingIds?: string[];
    /** Drop findings whose evidence file matches these glob patterns. */
    filePatterns?: string[];
  };

  // ── Thresholds ──
  thresholds?: {
    /** Lowest severity that should fail CI (advisory metadata). */
    failOn?: Severity;
    /** More than this many medium findings ⇒ launch-with-monitoring. */
    maxMedium?: number;
    /** Per-domain severity floor: findings below this are dropped. */
    perDomain?: Partial<Record<Domain, Severity>>;
  };

  // ── Tool settings ──
  tools?: Record<
    string,
    { enabled?: boolean; extraConfigs?: string[]; minScore?: number; args?: string[]; configPath?: string }
  >;

  // ── Extensions ──
  /** Free-form audit objectives, shown in the report header. */
  objectives?: string[];
  /** Named risk profile that tunes verdict ceilings. */
  riskProfile?: "startup-mvp" | "standard" | "regulated";
  /** OWASP ASVS mapping — which controls this audit claims to cover. */
  asvs?: {
    version: string;
    level?: 1 | 2 | 3;
    controls?: string[];
  };
}

export interface AuditReport {
  meta: {
    generatedAt: string;
    auditVersion: string;
    config: AuditConfig;
    durationMs: number;
  };
  verdict: Verdict;
  verdictReason: string;
  scores: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  hardBlockers: Finding[];
  results: CheckResult[];
  manualChecklist: Array<{ domain: Domain; item: string; rationale: string; critical?: boolean }>;
  tooling: Record<string, { available: boolean; path?: string; version?: string }>;
  /** Coverage assessment — what was actually audited vs. skipped/degraded. */
  coverage: CoverageReport;
}

export interface CoverageGap {
  kind: string;
  /** blocking → caps at private-beta-only; soft → caps at launch-with-monitoring */
  severity: "blocking" | "soft";
  detail: string;
}

export interface CoverageReport {
  /** Per-domain coverage status for the report table. */
  perDomain: Array<{ domain: Domain; status: CoverageStatus; reason?: string }>;
  gaps: CoverageGap[];
  /** Core scanners that were required but unavailable. */
  missingScanners: string[];
  /** Best verdict the coverage allows; final verdict = worst(findings, ceiling). */
  ceiling: Verdict;
  /** True when coverage alone (independent of findings) blocks launch-ready. */
  incomplete: boolean;
}

export interface CheckModule {
  domain: Domain;
  description: string;
  run(config: AuditConfig): Promise<CheckResult>;
}
