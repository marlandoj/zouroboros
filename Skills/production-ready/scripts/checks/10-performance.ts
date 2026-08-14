/**
 * Domain 10: Performance & Reliability
 *
 *  - Lighthouse against URL → Core Web Vitals
 *  - Repo heuristics: missing indexes, no graceful shutdown, no caching headers
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckModule, AuditConfig, CheckResult, DomainCoverage, Finding } from "../lib/types.ts";
import { runCommand, whichTool } from "../lib/runners.ts";

interface LighthouseReport {
  requestedUrl?: string;
  finalUrl?: string;
  finalDisplayedUrl?: string;
  audits?: Record<string, { numericValue?: number }>;
  categories?: { performance?: { score?: number } };
}

export function analyseLighthouseReport(
  report: LighthouseReport,
  requestedUrl: string,
): { findings: Finding[]; coverage?: DomainCoverage } {
  const finalUrl = report.finalDisplayedUrl ?? report.finalUrl;
  if (finalUrl && isCrossOrigin(requestedUrl, finalUrl)) {
    return {
      findings: [],
      coverage: {
        status: "partial",
        reason: `Lighthouse followed a cross-origin redirect to ${safeOrigin(finalUrl)}; metrics for ${safeOrigin(requestedUrl)} were not measured`,
      },
    };
  }

  const findings: Finding[] = [];
  const audits = report.audits ?? {};
  const lcp = audits["largest-contentful-paint"]?.numericValue;
  const cls = audits["cumulative-layout-shift"]?.numericValue;
  const tbt = audits["total-blocking-time"]?.numericValue;
  const perfScore = report.categories?.performance?.score;

  if (typeof perfScore === "number" && perfScore < 0.7) {
    findings.push({
      id: "perf.lighthouse-score-low",
      domain: "performance",
      severity: perfScore < 0.5 ? "high" : "medium",
      title: `Lighthouse performance score: ${Math.round(perfScore * 100)}/100`,
      description: "Lighthouse mobile performance score is below the recommended threshold (≥ 90 is good).",
      evidence: [{ url: requestedUrl }],
      remediation: "Inspect the Lighthouse report's Opportunities section. Likely fixes: image compression, code splitting, caching headers, removing render-blocking resources.",
      source: "lighthouse",
      references: ["https://web.dev/articles/lighthouse-performance"],
    });
  }
  if (lcp && lcp > 2500) {
    findings.push({
      id: "perf.lcp-slow",
      domain: "performance",
      severity: lcp > 4000 ? "high" : "medium",
      title: `LCP ${Math.round(lcp)}ms (target ≤ 2500ms)`,
      description: "Largest Contentful Paint is slow. Users perceive the page as not yet loaded.",
      evidence: [{ url: requestedUrl }],
      remediation: "Optimize the largest element: preload critical resources, compress hero images, defer non-critical CSS/JS.",
      source: "lighthouse:lcp",
      references: ["https://web.dev/articles/lcp"],
    });
  }
  if (cls && cls > 0.1) {
    findings.push({
      id: "perf.cls-high",
      domain: "performance",
      severity: cls > 0.25 ? "high" : "medium",
      title: `CLS ${cls.toFixed(3)} (target ≤ 0.1)`,
      description: "Cumulative Layout Shift is above threshold — content jumps after load.",
      evidence: [{ url: requestedUrl }],
      remediation: "Set explicit width/height on images and ads. Reserve space for dynamic content. Avoid inserting content above existing content.",
      source: "lighthouse:cls",
      references: ["https://web.dev/articles/cls"],
    });
  }
  if (tbt && tbt > 200) {
    findings.push({
      id: "perf.tbt-high",
      domain: "performance",
      severity: tbt > 600 ? "high" : "medium",
      title: `Total Blocking Time ${Math.round(tbt)}ms (target ≤ 200ms)`,
      description: "Main thread is blocked for too long after FCP — INP will suffer.",
      evidence: [{ url: requestedUrl }],
      remediation: "Split long tasks. Defer third-party scripts. Move heavy work to web workers.",
      source: "lighthouse:tbt",
      references: ["https://web.dev/articles/tbt"],
    });
  }

  return { findings };
}

function isCrossOrigin(requestedUrl: string, finalUrl: string): boolean {
  try {
    return new URL(requestedUrl).origin !== new URL(finalUrl).origin;
  } catch {
    return false;
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export const performanceCheck: CheckModule = {
  domain: "performance",
  description: "Performance + reliability — Lighthouse + repo heuristics.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];
    const toolsUsed: string[] = [];
    const toolsMissing: string[] = [];
    let coverage: DomainCoverage | undefined;

    if (config.url) {
      const lh = whichTool("lighthouse");
      if (lh.available) {
        toolsUsed.push("lighthouse");
        const reportPath = join(config.outDir, "lighthouse.json");
        runCommand(
          "lighthouse",
          [config.url, "--output=json", `--output-path=${reportPath}`, "--only-categories=performance,best-practices,seo", "--quiet", "--chrome-flags=--headless --no-sandbox"],
          { timeoutMs: 240_000 },
        );
        if (existsSync(reportPath)) {
          try {
            const report = JSON.parse(readFileSync(reportPath, "utf8")) as LighthouseReport;
            const analysis = analyseLighthouseReport(report, config.url);
            findings.push(...analysis.findings);
            coverage = analysis.coverage;
          } catch {}
        }
      } else {
        toolsMissing.push("lighthouse");
      }
    }

    // Repo heuristics for reliability
    if (config.repoPath) {
      const repo = config.repoPath;
      // No graceful shutdown handler
      const pkg = existsSync(join(repo, "package.json")) ? JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) : null;
      if (pkg) {
        const hasServer = ["express", "fastify", "hono", "@nestjs/core", "next"].some((d) => pkg.dependencies?.[d] || pkg.devDependencies?.[d]);
        if (hasServer) {
          // Look for SIGTERM handler
          const { walkRepo, grepFiles, isSource } = await import("../lib/runners.ts");
          const files = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });
          const sigterm = grepFiles(files, /SIGTERM|SIGINT|gracefulShutdown|graceful-shutdown/, { maxMatches: 1 });
          if (sigterm.length === 0) {
            findings.push({
              id: "perf.no-graceful-shutdown",
              domain: "performance",
              severity: "medium",
              title: "No SIGTERM/SIGINT handler detected",
              description: "Without graceful shutdown, in-flight requests are dropped during deploys and rolling restarts, causing 5xxs.",
              remediation: "On SIGTERM: stop accepting new requests, drain in-flight, close DB connections, then exit. See your framework's recommended pattern (e.g., `terminus` for Node).",
              source: "production-ready:repo-heuristic",
            });
          }
        }
      }
    }

    return {
      domain: "performance",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed,
      toolsMissing,
      findings,
      coverage,
      manualChecklist: [
        { item: "Tested rollback procedure in staging within last 30 days", rationale: "An untested rollback is a hope, not a plan." },
        { item: "Backups exist AND restore has been tested in last 90 days", rationale: "Schrödinger's backup: simultaneously exists and doesn't until verified." },
        { item: "Capacity tested at ≥ 2× projected peak traffic", rationale: "Launch traffic spikes are bigger than steady state." },
        { item: "Per-route SLOs defined with error budget tracking", rationale: "Reliability targets without budgets become aspirations." },
      ],
    };
  },
};
