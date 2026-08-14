/**
 * Generate copy-paste remediation prompts for findings.
 * Format is agent-agnostic (works with Claude Code, Cursor, Aider).
 */

import type { Finding } from "./types.ts";

export function findingToPrompt(f: Finding, repoPath?: string): string {
  const lines: string[] = [];
  lines.push(`# Remediation: ${f.title}`);
  lines.push("");
  lines.push(`**Severity:** ${f.severity}${f.hardBlocker ? " (HARD BLOCKER)" : ""}`);
  lines.push(`**Domain:** ${f.domain}`);
  lines.push(`**Source:** ${f.source}`);
  if (f.references && f.references.length) {
    lines.push(`**References:** ${f.references.join(", ")}`);
  }
  lines.push("");
  lines.push("## Problem");
  lines.push("");
  lines.push(f.description);
  lines.push("");

  if (f.evidence && f.evidence.length) {
    lines.push("## Evidence");
    lines.push("");
    for (const e of f.evidence.slice(0, 10)) {
      if (e.url) {
        lines.push(`- ${e.url}`);
      } else if (e.file) {
        const loc = e.line ? `${e.file}:${e.line}` : e.file;
        lines.push(`- \`${loc}\``);
        if (e.snippet) {
          lines.push(`  \`\`\``);
          lines.push(`  ${e.snippet}`);
          lines.push(`  \`\`\``);
        }
      }
    }
    lines.push("");
  }

  lines.push("## What to do");
  lines.push("");
  lines.push(f.remediation);
  lines.push("");

  if (f.agentPrompt) {
    lines.push("## Agent instruction");
    lines.push("");
    lines.push("```");
    lines.push(f.agentPrompt);
    lines.push("```");
    lines.push("");
  } else {
    lines.push("## Agent instruction");
    lines.push("");
    lines.push("```");
    lines.push(buildDefaultAgentPrompt(f, repoPath));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function buildDefaultAgentPrompt(f: Finding, repoPath?: string): string {
  const evidenceList = (f.evidence ?? [])
    .slice(0, 5)
    .map((e) => (e.file ? `- ${e.file}${e.line ? `:${e.line}` : ""}` : e.url ? `- ${e.url}` : ""))
    .filter(Boolean)
    .join("\n");

  return [
    `You are fixing a production-readiness audit finding in ${repoPath ?? "this repo"}.`,
    ``,
    `Finding: ${f.title}`,
    `Severity: ${f.severity}${f.hardBlocker ? " (hard blocker)" : ""}`,
    ``,
    `Problem:`,
    f.description,
    ``,
    evidenceList ? `Evidence:\n${evidenceList}\n` : ``,
    `Required fix:`,
    f.remediation,
    ``,
    `Acceptance criteria:`,
    `1. The finding above no longer reproduces (re-run the production-ready audit and confirm).`,
    `2. No regressions in existing tests.`,
    `3. Do not introduce broader scope — fix only this finding.`,
    `4. If a fix requires data migration or env-var changes, surface them in the PR description.`,
    ``,
    `Implement the fix, then write a one-paragraph summary of what changed and why.`,
  ].join("\n");
}

export function buildPromptPack(findings: Finding[], repoPath?: string): Map<string, string> {
  const pack = new Map<string, string>();
  for (const f of findings) {
    const slug = f.id.replace(/[^a-z0-9.-]/gi, "_");
    pack.set(`${slug}.md`, findingToPrompt(f, repoPath));
  }
  return pack;
}
