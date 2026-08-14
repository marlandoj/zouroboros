/**
 * Render audit reports in Markdown and HTML.
 */

import type { AuditReport, Finding, Severity } from "./types.ts";
import { VERDICT_EMOJI, VERDICT_LABEL } from "./verdict.ts";
import { COVERAGE_ICON, COVERAGE_LABEL } from "./coverage.ts";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" };

const DOMAIN_TITLES: Record<string, string> = {
  legal: "Legal & Data Handling",
  secrets: "Secrets & Credential Exposure",
  authentication: "Authentication & Authorization",
  "api-safety": "API Route Safety",
  owasp: "OWASP Baseline",
  "abuse-rate": "Abuse, Cost & Rate Limits",
  frontend: "Frontend Exposure",
  logging: "Logging & Monitoring",
  accessibility: "Accessibility",
  performance: "Performance & Reliability",
  payments: "Payments & Webhooks",
  "file-uploads": "File Upload Safety",
  database: "Database & Data Access",
  "ai-code": "AI-Generated Code Failure Modes",
  "browser-test": "Browser Testing",
  concurrency: "Concurrency & State Integrity",
  "visual-consistency": "Visual Consistency",
};

const REMEDIATION_CLASS_LABEL: Record<string, string> = {
  "quick-win": "Quick win",
  config: "Config change",
  "code-change": "Code change",
  architectural: "Architectural",
};

export function renderMarkdown(r: AuditReport): string {
  const lines: string[] = [];
  const allFindings = r.results.flatMap((c) => c.findings).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  lines.push(`# Production-Readiness Audit`);
  lines.push(``);
  lines.push(`**Generated:** ${r.meta.generatedAt}`);
  if (r.meta.config.appName) lines.push(`**App:** ${r.meta.config.appName}${r.meta.config.appPurpose ? ` — ${r.meta.config.appPurpose}` : ""}`);
  if (r.meta.config.repoPath) lines.push(`**Repo:** \`${r.meta.config.repoPath}\``);
  if (r.meta.config.url) lines.push(`**URL:** ${r.meta.config.url}`);
  lines.push(`**Audit duration:** ${(r.meta.durationMs / 1000).toFixed(1)}s`);
  const policy = r.meta.config.policy;
  if (policy?.riskProfile) lines.push(`**Risk profile:** ${policy.riskProfile}`);
  if (policy?.asvs) lines.push(`**Target:** OWASP ASVS ${policy.asvs.version}${policy.asvs.level ? ` (L${policy.asvs.level})` : ""}`);
  lines.push(``);
  if (policy?.objectives?.length) {
    lines.push(`**Audit objectives:**`);
    lines.push(``);
    for (const o of policy.objectives) lines.push(`- ${o}`);
    lines.push(``);
  }
  if (policy?.asvs?.controls?.length) {
    lines.push(`**ASVS controls in scope:** ${policy.asvs.controls.map((c) => `\`${c}\``).join(", ")}`);
    lines.push(``);
  }

  lines.push(`## Verdict — ${VERDICT_EMOJI[r.verdict]} ${VERDICT_LABEL[r.verdict]}`);
  lines.push(``);
  lines.push(`> ${r.verdictReason}`);
  lines.push(``);
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| ${SEVERITY_ICON.critical} Critical | ${r.scores.critical} |`);
  lines.push(`| ${SEVERITY_ICON.high} High | ${r.scores.high} |`);
  lines.push(`| ${SEVERITY_ICON.medium} Medium | ${r.scores.medium} |`);
  lines.push(`| ${SEVERITY_ICON.low} Low | ${r.scores.low} |`);
  lines.push(`| ${SEVERITY_ICON.info} Info | ${r.scores.info} |`);
  lines.push(``);

  // ── Coverage: what did we actually audit? ──
  if (r.coverage) {
    lines.push(`## Coverage`);
    lines.push(``);
    if (r.coverage.incomplete) {
      lines.push(
        `> ⚠️ This audit was **incomplete** — coverage gaps cap the verdict at **${VERDICT_LABEL[r.coverage.ceiling]}**. A clean result here means "no problems found in what we could inspect", not "safe to launch".`,
      );
    } else {
      lines.push(`> ✅ Coverage complete — all domains audited, no core scanners missing.`);
    }
    lines.push(``);
    if (r.coverage.gaps.length > 0) {
      lines.push(`**Coverage gaps:**`);
      lines.push(``);
      for (const g of r.coverage.gaps) {
        lines.push(`- ${g.severity === "blocking" ? "🚧 **blocking**" : "• soft"} — ${g.detail}`);
      }
      lines.push(``);
    }
    lines.push(`| Domain | Coverage |`);
    lines.push(`|--------|----------|`);
    for (const d of r.coverage.perDomain) {
      const title = DOMAIN_TITLES[d.domain] ?? d.domain;
      lines.push(`| ${title} | ${COVERAGE_ICON[d.status]} ${COVERAGE_LABEL[d.status]}${d.reason ? ` — ${d.reason}` : ""} |`);
    }
    lines.push(``);
  }

  if (r.hardBlockers.length > 0) {
    lines.push(`## 🚨 Hard Blockers — must fix before launch`);
    lines.push(``);
    for (const f of r.hardBlockers) {
      lines.push(`- **${f.title}** — ${f.domain} — \`${f.id}\``);
    }
    lines.push(``);
  }

  // ── Quick wins vs. deeper work (from remediationClass) ──
  const allFindingsForTriage = r.results.flatMap((c) => c.findings);
  const quickWins = allFindingsForTriage.filter((f) => f.remediationClass === "quick-win" || f.remediationClass === "config");
  const codeChanges = allFindingsForTriage.filter((f) => f.remediationClass === "code-change");
  const deepWork = allFindingsForTriage.filter((f) => f.remediationClass === "architectural");
  const bySeverity = (a: Finding, b: Finding) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  const renderShape = (heading: string, bucket: Finding[]) => {
    if (bucket.length === 0) return;
    lines.push(`### ${heading} — ${bucket.length}`);
    lines.push(``);
    for (const f of bucket.sort(bySeverity)) {
      lines.push(`- ${SEVERITY_ICON[f.severity]} **${f.title}** — \`${f.id}\``);
    }
    lines.push(``);
  };
  if (quickWins.length > 0 || codeChanges.length > 0 || deepWork.length > 0) {
    lines.push(`## Remediation shape`);
    lines.push(``);
    renderShape("✅ Quick wins (config / one-liners)", quickWins);
    renderShape("🔧 Targeted code changes", codeChanges);
    renderShape("🏗️ Architectural work", deepWork);
  }

  // Tooling
  const toolEntries = Object.entries(r.tooling);
  if (toolEntries.length > 0) {
    lines.push(`## Tooling`);
    lines.push(``);
    lines.push(`| Tool | Available | Version |`);
    lines.push(`|------|-----------|---------|`);
    for (const [name, info] of toolEntries) {
      lines.push(`| \`${name}\` | ${info.available ? "✅" : "❌"} | ${info.version ?? "—"} |`);
    }
    lines.push(``);
  }

  // Per-domain results
  lines.push(`## Findings by domain`);
  lines.push(``);
  for (const result of r.results) {
    const domainTitle = DOMAIN_TITLES[result.domain] ?? result.domain;
    lines.push(`### ${domainTitle}`);
    lines.push(``);
    lines.push(`*Ran in ${(result.durationMs / 1000).toFixed(2)}s with: ${result.toolsUsed.join(", ") || "none"}*`);
    if (result.toolsMissing.length > 0) {
      lines.push(``);
      lines.push(`> Missing tools: ${result.toolsMissing.map((t) => `\`${t}\``).join(", ")}`);
    }
    lines.push(``);
    if (result.error) {
      lines.push(`**Error:** ${result.error}`);
      lines.push(``);
    }
    if (result.findings.length === 0) {
      lines.push(`✅ No findings in this domain.`);
    } else {
      for (const f of [...result.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
        lines.push(`#### ${SEVERITY_ICON[f.severity]} ${f.title}${f.hardBlocker ? " (HARD BLOCKER)" : ""}`);
        lines.push(``);
        const meta = [`${f.severity.toUpperCase()} — ${f.source}`];
        if (f.confidence) meta.push(`confidence: ${f.confidence}`);
        if (f.verificationStatus) meta.push(f.verificationStatus);
        if (f.remediationClass) meta.push(REMEDIATION_CLASS_LABEL[f.remediationClass] ?? f.remediationClass);
        if (f.affectedFlow) meta.push(`flow: ${f.affectedFlow}`);
        lines.push(`*${meta.join(" · ")}*`);
        lines.push(``);
        lines.push(f.description);
        lines.push(``);
        if (f.impact) {
          lines.push(`**Impact:** ${f.impact}`);
          lines.push(``);
        }
        if (f.reproduction) {
          lines.push(`**Reproduce:** ${f.reproduction}`);
          lines.push(``);
        }
        if (f.evidence && f.evidence.length) {
          lines.push(`**Evidence:**`);
          lines.push(``);
          for (const e of f.evidence.slice(0, 8)) {
            if (e.url) {
              lines.push(`- \`${e.url}\`${e.snippet ? ` — \`${e.snippet}\`` : ""}`);
            } else if (e.file) {
              lines.push(`- \`${e.file}${e.line ? `:${e.line}` : ""}\`${e.snippet ? `\n  \`\`\`\n  ${e.snippet}\n  \`\`\`` : ""}`);
            }
          }
          lines.push(``);
        }
        lines.push(`**Fix:**`);
        lines.push(``);
        lines.push(f.remediation);
        if (f.references && f.references.length) {
          lines.push(``);
          lines.push(`**References:** ${f.references.map((u) => `<${u}>`).join(", ")}`);
        }
        lines.push(``);
      }
    }
    if (result.manualChecklist.length > 0) {
      lines.push(`**Manual review for this domain:**`);
      lines.push(``);
      for (const m of result.manualChecklist) {
        lines.push(`- [ ] ${m.critical ? "**🔒 (gates launch)** " : ""}${m.item}`);
        lines.push(`  - *why:* ${m.rationale}`);
      }
      lines.push(``);
    }
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join("\n");
}

export function renderHtml(r: AuditReport): string {
  const md = renderMarkdown(r);
  // Minimal Markdown → HTML conversion (no external deps)
  const html = simpleMarkdownToHtml(md);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Production-Readiness Audit ${r.meta.config.appName ?? ""} — ${VERDICT_LABEL[r.verdict]}</title>
<style>
  :root {
    --bg: #0b0d12;
    --fg: #e6e8ee;
    --muted: #8b93a7;
    --card: #141821;
    --border: rgba(255,255,255,0.08);
    --accent: #7dd3fc;
    --crit: #f43f5e;
    --high: #f97316;
    --med: #eab308;
    --low: #38bdf8;
    --info: #94a3b8;
  }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 0; line-height: 1.55; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 32px; margin-bottom: 8px; letter-spacing: -0.02em; }
  h2 { margin-top: 40px; padding-bottom: 8px; border-bottom: 1px solid var(--border); font-size: 22px; }
  h3 { margin-top: 28px; font-size: 18px; color: var(--accent); }
  h4 { margin-top: 22px; font-size: 16px; }
  code, pre { font-family: ui-monospace, "SF Mono", monospace; font-size: 13px; }
  pre { background: var(--card); border: 1px solid var(--border); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  code { background: var(--card); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }
  pre code { background: transparent; border: 0; padding: 0; }
  table { border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
  th { background: var(--card); }
  blockquote { border-left: 3px solid var(--accent); padding: 4px 16px; margin: 16px 0; color: var(--muted); background: rgba(125,211,252,0.05); border-radius: 0 6px 6px 0; }
  a { color: var(--accent); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  .verdict-do-not-launch { color: var(--crit); }
  .verdict-private-beta-only { color: var(--high); }
  .verdict-launch-with-monitoring { color: var(--med); }
  .verdict-launch-ready { color: #4ade80; }
</style>
</head>
<body>
<div class="container">
${html}
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function simpleMarkdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Fenced code
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    // Tables (very basic)
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^-+:?$/.test(c) || /^:?-+:?$/.test(c))) continue;
      if (!inTable) {
        out.push("<table>");
        inTable = true;
        out.push("<tr>" + cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr>");
      } else {
        out.push("<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      continue;
    } else if (inTable) {
      out.push("</table>");
      inTable = false;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      let text = h[2];
      let cls = "";
      if (level === 2 && text.includes("Verdict")) {
        cls = ` class="verdict-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}"`;
      }
      out.push(`<h${level}${cls}>${inline(text)}</h${level}>`);
      continue;
    }

    if (line.startsWith("> ")) {
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      continue;
    }
    if (line.match(/^[-*]\s+/) || line.match(/^\d+\.\s+/)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    } else if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (line.trim() === "---") {
      out.push("<hr>");
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  if (inTable) out.push("</table>");
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function inline(s: string): string {
  // Order matters: code, bold, italic, links
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/<(https?:\/\/[^>]+)>/g, '<a href="$1">$1</a>');
}
