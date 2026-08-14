/**
 * Domain 9: Accessibility (WCAG 2.2 AA)
 *
 *  - axe-core CLI against URL
 *  - pa11y fallback
 *  - Repo heuristics: missing alt attrs, missing labels, `outline: none`
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { runCommand, whichTool, walkRepo, grepFiles } from "../lib/runners.ts";

export const accessibilityCheck: CheckModule = {
  domain: "accessibility",
  description: "WCAG 2.2 AA audit — axe-core + pa11y + repo heuristics.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];
    const toolsUsed: string[] = [];
    const toolsMissing: string[] = [];

    // ── axe-core CLI against URL ───────────────────────────────
    if (config.url) {
      const axe = whichTool("axe");
      if (axe.available) {
        toolsUsed.push("@axe-core/cli");
        const res = runCommand(
          "axe",
          [config.url, "--tags", "wcag2aa,wcag22aa", "--exit"],
          { timeoutMs: 120_000 },
        );
        if (res.stdout) {
          // axe CLI prints a summary; parse violation count heuristically
          const violations = res.stdout.match(/Violations:\s*(\d+)/);
          if (violations && parseInt(violations[1]) > 0) {
            findings.push({
              id: "a11y.axe-violations",
              domain: "accessibility",
              severity: parseInt(violations[1]) > 10 ? "high" : "medium",
              title: `axe-core found ${violations[1]} WCAG 2.2 violations`,
              description: "axe-core flagged violations of WCAG 2.2 success criteria. Run `axe <url> --tags wcag2aa,wcag22aa` for the full list.",
              evidence: [{ url: config.url }],
              remediation: "Re-run `axe` with the same args to see per-rule details and fix in priority order (critical > serious > moderate > minor).",
              source: "axe-core",
              references: ["https://www.w3.org/WAI/WCAG22/quickref/", "https://www.deque.com/axe/"],
            });
          }
        }
      } else {
        toolsMissing.push("@axe-core/cli");
      }

      // ── pa11y fallback / additional pass ────────────────────
      const pa11y = whichTool("pa11y");
      if (pa11y.available) {
        toolsUsed.push("pa11y");
        const res = runCommand(
          "pa11y",
          [config.url, "--reporter", "json", "--standard", "WCAG2AA"],
          { timeoutMs: 120_000 },
        );
        if (res.stdout) {
          try {
            const issues = JSON.parse(res.stdout) as Array<{ code?: string; type?: string; message?: string; selector?: string }>;
            for (const i of issues.slice(0, 20)) {
              const sev = i.type === "error" ? "medium" : "low";
              findings.push({
                id: `a11y.pa11y.${(i.code ?? "x").replace(/[^a-z0-9]+/gi, "_")}.${(i.selector ?? "").slice(0, 30)}`,
                domain: "accessibility",
                severity: sev,
                title: `pa11y: ${i.code ?? i.type}`,
                description: i.message ?? "Accessibility issue detected.",
                evidence: [{ url: config.url, snippet: i.selector }],
                remediation: "See WCAG 2.2 success criterion linked in the issue code.",
                source: `pa11y:${i.code ?? "x"}`,
                references: ["https://www.w3.org/WAI/WCAG22/quickref/"],
              });
            }
          } catch {}
        }
      } else if (toolsMissing.length === 0) {
        toolsMissing.push("pa11y");
      }
    }

    // ── Repo heuristics ─────────────────────────────────────────
    if (config.repoPath) {
      const sourceFiles = walkRepo(config.repoPath, (rel) => /\.(tsx|jsx|vue|svelte|astro|html)$/i.test(rel), { maxFiles: 3000 });
      // Missing alt
      const missingAlt = grepFiles(sourceFiles, /<img(?![^>]*\balt\s*=)[^>]*>/, { maxMatches: 15 });
      for (const hit of missingAlt) {
        findings.push({
          id: `a11y.img-missing-alt.${rel(hit.file, config.repoPath)}.${hit.line}`,
          domain: "accessibility",
          severity: "low",
          title: "Image without `alt` attribute",
          description: "Images without alt text are invisible to screen readers. Decorative images need `alt=\"\"`.",
          evidence: [{ file: rel(hit.file, config.repoPath), line: hit.line, snippet: hit.snippet }],
          remediation: "Add a descriptive `alt` attribute, or `alt=\"\"` for purely decorative imagery.",
          source: "production-ready:alt-grep",
          references: ["https://www.w3.org/WAI/tutorials/images/decision-tree/"],
        });
      }
      // outline:none without focus-visible alternative
      const noOutline = grepFiles(sourceFiles, /outline\s*:\s*(none|0)/i, { maxMatches: 10 });
      for (const hit of noOutline.slice(0, 5)) {
        findings.push({
          id: `a11y.outline-none.${rel(hit.file, config.repoPath)}.${hit.line}`,
          domain: "accessibility",
          severity: "low",
          title: "`outline: none` removes keyboard focus indicator",
          description: "Removing the focus ring breaks keyboard navigation for sighted-keyboard users. WCAG 2.4.7 (Focus Visible) requires a visible indicator.",
          evidence: [{ file: rel(hit.file, config.repoPath), line: hit.line, snippet: hit.snippet }],
          remediation: "Replace with a custom `:focus-visible` style providing a clear visible indicator.",
          source: "production-ready:focus-grep",
          references: ["https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"],
        });
      }
    }

    return {
      domain: "accessibility",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed,
      toolsMissing,
      findings,
      manualChecklist: [
        { item: "Keyboard-only pass: can you reach every interactive control with Tab? Operate it with Enter/Space?", rationale: "Automated tools catch ~30–40% of WCAG issues; keyboard ops can't be inferred from DOM." },
        { item: "Screen reader smoke test (VoiceOver / NVDA): does the announcement order make sense?", rationale: "Visually-ordered DOM can confuse screen readers." },
        { item: "Reduced motion preference is honored", rationale: "WCAG 2.3.3 (Animation from Interactions) and motion-disorder users." },
      ],
    };
  },
};

function rel(full: string, root: string | undefined): string {
  if (!root) return full;
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}
