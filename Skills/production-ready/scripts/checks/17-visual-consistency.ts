/**
 * Domain 17: Visual Consistency
 *
 * AI-generated UIs drift: each screen re-invents colors, spacing, and radii
 * instead of using the design system. This produces a subtly-broken product
 * that "works" but looks unfinished. These are static heuristics over the
 * source; the perceptual checks (typography rhythm, state coverage, overflow,
 * localization) are emitted as a manual checklist.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, AuditConfig, CheckResult, Finding, ManualCheckItem } from "../lib/types.ts";
import { walkRepo, grepFiles, safeRead } from "../lib/runners.ts";

function rel(full: string, root: string): string {
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}

const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss)$/;

export const visualConsistencyCheck: CheckModule = {
  domain: "visual-consistency",
  description: "Design-token drift, arbitrary Tailwind values, inline styles, and a UI-polish checklist.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) {
      return {
        domain: "visual-consistency",
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        toolsUsed: [],
        toolsMissing: [],
        findings: [],
        manualChecklist: [{ item: "Provide --repo to run visual-consistency heuristics.", rationale: "Source access required." }],
        coverage: { status: "not-run", reason: "no --repo provided" },
      };
    }
    const repo = config.repoPath;
    const uiFiles = walkRepo(repo, (r) => UI_EXT.test(r), { maxFiles: 4000 });

    // Whether the repo even has a design-token layer to drift from.
    const hasTokens =
      existsSync(join(repo, "tailwind.config.js")) ||
      existsSync(join(repo, "tailwind.config.ts")) ||
      grepFiles(uiFiles.filter((f) => /\.(css|scss)$/.test(f)), /--[\w-]+\s*:/, { maxMatches: 1 }).length > 0;

    // ── 1. Raw hex colors in component/style source (token drift) ──
    // Skip token-definition files (tailwind config, :root css vars) where hex
    // is expected.
    const colorTargets = uiFiles.filter((f) => !/tailwind\.config\.[jt]s$/.test(f));
    const hexHits = grepFiles(colorTargets, /#[0-9a-fA-F]{6}\b/, { maxMatches: 60 });
    // Count distinct colors + files to judge severity.
    const distinctHex = new Set(hexHits.map((h) => h.match.toLowerCase()));
    const hexFiles = new Set(hexHits.map((h) => h.file));
    if (hasTokens && hexHits.length > 0) {
      findings.push({
        id: "visual.raw-hex-color-drift",
        domain: "visual-consistency",
        severity: distinctHex.size > 12 ? "medium" : "low",
        title: `${distinctHex.size} distinct raw hex color(s) across ${hexFiles.size} file(s)`,
        description:
          "The project defines a design-token / theme layer, but components hard-code hex colors directly. Each hard-coded value drifts from the palette and won't respond to theme or dark-mode changes.",
        evidence: hexHits.slice(0, 8).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        impact: "Inconsistent, off-palette colors and broken dark mode; every future palette change misses these call sites.",
        confidence: "medium",
        verificationStatus: "heuristic",
        remediationClass: "code-change",
        remediation:
          "Replace raw hex with a design token (Tailwind color class or CSS variable). If a color is genuinely new, add it to the token layer first, then reference it.",
        source: "production-ready:token-drift",
      });
    }

    // ── 2. Arbitrary Tailwind values (magic numbers) ──
    const arbitrary = grepFiles(uiFiles, /\b(w|h|p|m|px|py|text|gap|top|left|right|bottom|rounded)-\[[^\]]+\]/, { maxMatches: 60 });
    const arbFiles = new Set(arbitrary.map((h) => h.file));
    if (arbitrary.length > 8) {
      findings.push({
        id: "visual.arbitrary-tailwind-values",
        domain: "visual-consistency",
        severity: "low",
        title: `${arbitrary.length} arbitrary Tailwind value(s) across ${arbFiles.size} file(s)`,
        description:
          "Frequent bracketed Tailwind values (e.g. `w-[137px]`, `text-[13px]`) bypass the spacing/typography scale. A few are fine; this many indicates the scale is being ignored, which reads as visually uneven.",
        evidence: arbitrary.slice(0, 8).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        impact: "Uneven spacing and type sizes that make the UI feel unpolished; hard to keep consistent as the app grows.",
        confidence: "low",
        verificationStatus: "heuristic",
        remediationClass: "code-change",
        remediation:
          "Prefer scale classes (`w-32`, `text-sm`). If a value recurs, add it to the Tailwind theme scale and use the named token.",
        source: "production-ready:arbitrary-values",
      });
    }

    // ── 3. Inline style objects with layout/color literals ──
    const inlineStyles = grepFiles(
      uiFiles.filter((f) => /\.(tsx|jsx|vue|svelte|astro)$/.test(f)),
      /style=\{\{[^}]*(color|background|padding|margin|width|height|font)[^}]*\}\}/i,
      { maxMatches: 40 },
    );
    const inlineFiles = new Set(inlineStyles.map((h) => h.file));
    if (inlineStyles.length > 5) {
      findings.push({
        id: "visual.inline-style-literals",
        domain: "visual-consistency",
        severity: "low",
        title: `${inlineStyles.length} inline style literal(s) across ${inlineFiles.size} file(s)`,
        description:
          "Inline `style={{…}}` with color/spacing/size literals sidesteps the styling system entirely, so these elements won't pick up tokens, theming, or responsive rules.",
        evidence: inlineStyles.slice(0, 8).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        impact: "Ad-hoc styling that ignores tokens and breakpoints; a common source of one-off visual inconsistencies.",
        confidence: "low",
        verificationStatus: "heuristic",
        remediationClass: "code-change",
        remediation: "Move inline literals into classes / token references. Reserve inline style for truly dynamic, computed values.",
        source: "production-ready:inline-style",
      });
    }

    const manualChecklist: ManualCheckItem[] = [
      {
        item: "Tab through every interactive element — confirm hover, focus-visible, active, and disabled states all exist and are distinct",
        rationale: "AI-generated components routinely ship only the default state; missing focus rings also fail accessibility.",
        critical: true,
      },
      {
        item: "Shrink to 320px and grow to 1440px+ — confirm no horizontal scroll, clipped text, or overlapping elements at any breakpoint",
        rationale: "Overflow and breakpoint gaps are perceptual and not detectable by grep.",
      },
      {
        item: "Render the loading, empty, error, and success state of every data view — confirm all four are designed, not just the happy path",
        rationale: "Empty/error/loading states are the most commonly missing screens in AI-built UIs.",
        critical: true,
      },
      {
        item: "Compare headings, body, and captions across 3+ screens — confirm one consistent type scale, not per-screen font sizes",
        rationale: "Typography drift is obvious to users but invisible to static checks.",
      },
      {
        item: "Fill fields with the longest realistic content (long names, long i18n strings, big numbers) — confirm nothing truncates or breaks layout",
        rationale: "Localization/content expansion (German, etc.) breaks fixed-width layouts.",
      },
      {
        item: "Spot-check that repeated components (buttons, cards, inputs) use one shared variant, not divergent one-off copies",
        rationale: "Component-variant drift accumulates silently across a codebase.",
      },
    ];

    return {
      domain: "visual-consistency",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:visual-heuristics"],
      toolsMissing: [],
      findings,
      manualChecklist,
      // Static heuristics can flag drift but cannot judge how it *looks*; the
      // perceptual half needs eyes (or the browser check with a URL).
      coverage: config.url
        ? { status: "partial", reason: "static drift heuristics; perceptual checks still manual" }
        : { status: "partial", reason: "no URL — static heuristics only, no rendered inspection" },
    };
  },
};
