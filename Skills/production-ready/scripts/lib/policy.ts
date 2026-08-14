/**
 * Declarative policy loading + application (--config).
 *
 * The config file (references/audit-config-schema.md) lets a repo pin its own
 * defaults, suppress known-benign findings, tune thresholds, and declare which
 * OWASP ASVS controls the audit is expected to cover.
 */

import { readFileSync } from "node:fs";
import type { AuditConfig, AuditPolicy, Finding, Severity } from "./types.ts";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function loadPolicy(path: string): AuditPolicy {
  if (/\.ya?ml$/i.test(path)) {
    throw new Error("YAML config is not supported — convert to JSON (audit.config.json).");
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("config must be a JSON object");
  }
  return parsed as AuditPolicy;
}

/**
 * Merge config-file defaults into the resolved AuditConfig. CLI values win:
 * a field is only filled from policy when it is still unset.
 */
export function mergePolicyIntoConfig(config: AuditConfig, policy: AuditPolicy): void {
  config.appName ??= policy.appName;
  config.appPurpose ??= policy.appPurpose;
  config.deployment ??= policy.deployment;
  config.url ??= policy.url;
  if (!config.techStack?.length && policy.techStack?.length) config.techStack = policy.techStack;
  if (policy.providers) config.providers = { ...policy.providers, ...config.providers };
  if (policy.surfaces) {
    config.surfaces = { ...policy.surfaces, ...config.surfaces };
  }
  // Suppressed domains fold into skip.
  if (policy.ignore?.domains?.length) {
    config.skip = [...new Set([...(config.skip ?? []), ...policy.ignore.domains])];
  }
  if (policy.thresholds?.failOn) config.failOn = policy.thresholds.failOn;
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/**
 * Simple `**`/`*` glob → RegExp, single-pass so a `*` we emit for a globstar is
 * never re-processed. `**` matches across path separators; `*` stays within a
 * single segment.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (REGEX_SPECIAL.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAnyPattern(file: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(file));
}

/**
 * Apply suppression + per-domain severity floors to a set of findings.
 * Does not mutate inputs; returns the surviving findings.
 */
export function applyPolicy(findings: Finding[], policy: AuditPolicy | undefined): Finding[] {
  if (!policy) return findings;
  const ignoreIds = policy.ignore?.findingIds ?? [];
  const filePatterns = policy.ignore?.filePatterns ?? [];
  const perDomain = policy.thresholds?.perDomain ?? {};

  return findings.filter((f) => {
    // Exact or substring id suppression.
    if (ignoreIds.some((id) => f.id === id || f.id.includes(id))) return false;

    // File-pattern suppression: drop only if ALL evidence is in ignored files
    // (a finding with evidence outside the ignored paths still matters).
    if (filePatterns.length && f.evidence?.length) {
      const files = f.evidence.map((e) => e.file).filter((x): x is string => !!x);
      if (files.length && files.every((file) => matchesAnyPattern(file, filePatterns))) return false;
    }

    // Per-domain severity floor.
    const floor = perDomain[f.domain];
    if (floor && SEVERITY_RANK[f.severity] < SEVERITY_RANK[floor]) return false;

    return true;
  });
}

/** maxMedium threshold: explicit value wins, else a risk-profile default. */
export function maxMediumThreshold(policy: AuditPolicy | undefined): number {
  if (typeof policy?.thresholds?.maxMedium === "number") return policy.thresholds.maxMedium;
  switch (policy?.riskProfile) {
    case "startup-mvp":
      return 5;
    case "regulated":
      return 1;
    default:
      return 3;
  }
}
