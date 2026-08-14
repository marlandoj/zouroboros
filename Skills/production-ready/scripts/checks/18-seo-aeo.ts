/**
 * Domain 18: SEO / AEO (Search & Answer-Engine Visibility)
 *
 * Evidence-classified. No ranking, traffic, or citation guarantees.
 *
 * What this check inspects:
 *   - RFC 9309 robots.txt presence + validity, sitemap.xml reachability/validity
 *   - Live HTML head: <title>, meta description, canonical, hreflang,
 *     Open Graph, JSON-LD structured data, robots meta / X-Robots-Tag
 *   - llms.txt presence (informational only — NOT a citation mechanism)
 *   - Lighthouse SEO category (optional — confirms rendered-vs-raw parity)
 *
 * What this check does NOT inspect (boundary):
 *   - DNS / TLS / edge / email / domain expiry — Cloudflare owns
 *   - Uptime / external reachability — Zo Computer owns
 *   - Core Web Vitals (LCP/INP/CLS) — Domain 10 (performance) owns;
 *     Lighthouse SEO touches LCP but we do not re-emit it as a finding here
 *   - WCAG / axe findings — Domain 9 (accessibility) owns
 *   - AI-bot policy intent (training vs search vs user-fetcher) — manual check;
 *     automation can detect directives but cannot confirm owner intent
 *
 * Evidence standard: every finding carries a confidence + verificationStatus.
 * Repo-only findings are `heuristic`; live-fetched findings are `verified`.
 * No fabricated metrics, search volume, bot behavior, or ranking factors.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditConfig, CheckModule, CheckResult, Finding, ManualCheckItem } from "../lib/types.ts";
import { runCommand, walkRepo, grepFiles, whichTool } from "../lib/runners.ts";

const DOMAIN = "seo-aeo" as const;

/** Page-template candidates where head metadata is emitted. */
const TEMPLATE_EXTS = /\.(html?|jsx?|tsx?|mdx|astro|vue|svelte)$/i;
const SKIP_DIRS = /^(node_modules|\.git|dist|build|\.next|\.nuxt|\.turbo|coverage|\.output|vendor|\.venv|venv|__pycache__|\.cache)\//;

function isTemplate(relPath: string): boolean {
  if (SKIP_DIRS.test(relPath)) return false;
  return TEMPLATE_EXTS.test(relPath);
}

/** Heuristic: does this repo look like a multi-page site (vs SPA)? */
function looksMultiPage(repoPath: string): boolean {
  const candidates = walkRepo(
    repoPath,
    (rel) => isTemplate(rel) && /\/(pages?|routes?|app|views|templates)\//i.test(rel),
    { maxFiles: 200 },
  );
  return candidates.length >= 2;
}

/** Extract <head> content from a raw HTML string. */
function extractHead(html: string): string {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html.slice(0, 4096);
}

/** Count occurrences of a regex in a string. */
function countMatches(haystack: string, pattern: RegExp): number {
  return (haystack.match(new RegExp(pattern.source, pattern.flags + "g")) || []).length;
}

/** Fetch a URL with curl, returning {status, headers, body} or null on failure. */
function fetchUrl(url: string, timeoutMs = 15000): { status: number; headers: string; body: string } | null {
  const r = runCommand("curl", ["-sSL", "-A", "zo-production-ready-seo-aeo/1.0", "--max-time", String(Math.floor(timeoutMs / 1000)), "-D", "-", "-o", "-", url], { timeoutMs });
  if (r.status !== 0 && !r.stdout) return null;
  // curl -D - writes headers + blank line + body to stdout
  const split = r.stdout.indexOf("\r\n\r\n");
  const splitLf = r.stdout.indexOf("\n\n");
  let headers = "";
  let body = r.stdout;
  if (split >= 0) {
    headers = r.stdout.slice(0, split);
    body = r.stdout.slice(split + 4);
  } else if (splitLf >= 0) {
    headers = r.stdout.slice(0, splitLf);
    body = r.stdout.slice(splitLf + 2);
  }
  const statusMatch = headers.match(/^HTTP\/[\d.]+\s+(\d{3})/im);
  return { status: statusMatch ? parseInt(statusMatch[1], 10) : 0, headers, body };
}

function fetchOnly(url: string, timeoutMs = 10000): { status: number; headers: string } | null {
  const r = runCommand("curl", ["-sSL", "-A", "zo-production-ready-seo-aeo/1.0", "--max-time", String(Math.floor(timeoutMs / 1000)), "-I", url], { timeoutMs });
  if (r.status !== 0 && !r.stdout) return null;
  const statusMatch = r.stdout.match(/^HTTP\/[\d.]+\s+(\d{3})/im);
  return { status: statusMatch ? parseInt(statusMatch[1], 10) : 0, headers: r.stdout };
}

interface ParsedHead {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  hreflangCount: number;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  jsonLdBlocks: number;
  robotsMeta: string | null;
  h1Count: number;
}

function parseHead(head: string, fullHtml: string): ParsedHead {
  const titleM = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM = head.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ||
    head.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  const canonM = head.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']*)["']/i);
  const hreflang = countMatches(head, /<link\s+rel=["']alternate["']\s+hreflang=/i);
  const ogTitleM = head.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
  const ogDescM = head.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i);
  const ogImgM = head.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i);
  const jsonLd = countMatches(head, /<script\s+type=["']application\/ld\+json["']/i);
  const robotsM = head.match(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i);
  const h1 = countMatches(fullHtml, /<h1[\s>]/i);

  return {
    title: titleM ? titleM[1].trim() : null,
    metaDescription: descM ? descM[1].trim() : null,
    canonical: canonM ? canonM[1].trim() : null,
    hreflangCount: hreflang,
    ogTitle: ogTitleM ? ogTitleM[1].trim() : null,
    ogDescription: ogDescM ? ogDescM[1].trim() : null,
    ogImage: ogImgM ? ogImgM[1].trim() : null,
    jsonLdBlocks: jsonLd,
    robotsMeta: robotsM ? robotsM[1].trim() : null,
    h1Count: h1,
  };
}

function baseOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** Parse robots.txt for AI-bot directives + sitemap references. */
function parseRobots(text: string): { sitemaps: string[]; aiBots: string[]; allDisallowed: boolean } {
  const sitemaps: string[] = [];
  const aiBots: string[] = [];
  const lines = text.split("\n");
  let currentUser = "";
  let allDisallowed = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = m;
    const lk = key.toLowerCase();
    if (lk === "sitemap") sitemaps.push(val.trim());
    else if (lk === "user-agent") currentUser = val.trim();
    else if (lk === "disallow" && currentUser === "*" && val.trim() === "/") allDisallowed = true;
    // AI-bot detection: only note presence of explicit Allow/Disallow for known AI crawlers
    if (lk === "user-agent" && /^(gptbot|oai-searchbot|chatgpt-user|claudebot|claude-searchbot|claude-user|ccbot|anthropic-ai|perplexitybot|google-extended|applebot-extended|cohere-ai|meta-externalagent|amazonbot)$/i.test(val.trim())) {
      aiBots.push(val.trim());
    }
  }
  return { sitemaps, aiBots, allDisallowed };
}

export const seoAeoCheck: CheckModule = {
  domain: DOMAIN,
  description:
    "Search & answer-engine visibility: RFC 9309 robots.txt, sitemap reachability, HTML head completeness (title, meta description, canonical, hreflang, Open Graph, JSON-LD), robots-meta/X-Robots-Tag directives, llms.txt presence (informational), and optional Lighthouse SEO render-parity. Does not re-emit Core Web Vitals (Domain 10) or accessibility (Domain 9). DNS/TLS/edge belong to Cloudflare; uptime to Zo.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const start = Date.now();
    const toolsUsed: string[] = ["curl"];
    const toolsMissing: string[] = [];
    const findings: Finding[] = [];
    const manual: ManualCheckItem[] = [];

    const lh = whichTool("lighthouse");
    if (!lh.available) toolsMissing.push("lighthouse");

    const url = config.url;
    const repoPath = config.repoPath;
    const multiPage = repoPath ? looksMultiPage(repoPath) : false;

    // ── Live fetch path (when a URL is provided) ──────────────────────
    let liveParsed: ParsedHead | null = null;
    let liveStatus = 0;
    let coverageReason: string | undefined;
    let coverageStatus: "pass" | "partial" | "fail" | "not-run" = "partial";

    if (url) {
      const page = fetchUrl(url);
      if (!page || page.status === 0) {
        coverageStatus = "fail";
        coverageReason = `could not fetch ${url} (curl failed)`;
        findings.push({
          id: "seo-aeo.fetch-failed",
          domain: DOMAIN,
          severity: "high",
          title: "Audit target URL could not be fetched",
          description: `curl could not retrieve \`${url}\`. Live SEO/AEO signals (title, canonical, robots, sitemap, JSON-LD) cannot be verified without a reachable page. Check DNS, TLS, and any WAF/edge rules (Cloudflare-owned) before re-running.`,
          evidence: [{ url }],
          remediation: "Confirm the URL resolves from a clean network, returns 200, and is not blocked by a WAF challenge for the audit user-agent.",
          source: "curl",
          confidence: "high",
          verificationStatus: "verified",
          affectedFlow: "crawl",
          remediationClass: "config",
        });
      } else {
        liveStatus = page.status;
        liveParsed = parseHead(extractHead(page.body), page.body);

        if (page.status >= 400) {
          coverageStatus = "fail";
          coverageReason = `${url} returned HTTP ${page.status}`;
          findings.push({
            id: "seo-aeo.non-200-status",
            domain: DOMAIN,
            severity: "high",
            title: `Audit URL returns HTTP ${page.status}`,
            description: `The page returned a ${page.status} status. Search engines and answer engines will not index error responses. Confirm the route is deployed and the origin is healthy.`,
            evidence: [{ url, snippet: `HTTP ${page.status}` }],
            remediation: "Deploy the route or fix the origin error so the canonical URL returns 200.",
            source: "curl",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        } else if (page.status >= 300 && page.status < 400) {
          // Redirects are fine; note for transparency
          coverageStatus = "pass";
        } else {
          coverageStatus = "pass";
        }

        // ── Title ──
        if (liveParsed && (!liveParsed.title || liveParsed.title.length < 10)) {
          findings.push({
            id: "seo-aeo.missing-title",
            domain: DOMAIN,
            severity: "high",
            title: "Missing or empty <title>",
            description: "Every indexable page needs a descriptive `<title>` (Google recommends ~60 chars). Missing titles are a clear defect that suppresses both SERP listings and answer-engine passage selection.",
            evidence: [{ url, snippet: liveParsed.title ? `title="${liveParsed.title}"` : "no <title> in <head>" }],
            remediation: "Add a unique, descriptive `<title>` per page. For template-driven sites, ensure the layout receives a per-route title prop.",
            agentPrompt: "Add a unique `<title>` element to the <head> of this page. Use a descriptive title under 60 characters that reflects the page's primary topic.",
            references: ["https://developers.google.com/search/docs/appearance/snippet#title"],
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        }

        // ── robots meta / X-Robots-Tag ──
        if (liveParsed?.robotsMeta && /noindex/i.test(liveParsed.robotsMeta)) {
          findings.push({
            id: "seo-aeo.noindex-detected",
            domain: DOMAIN,
            severity: "medium",
            title: "noindex directive on audit URL",
            description: `The page carries \`<meta name="robots" content="${liveParsed.robotsMeta}">\`. noindex removes the page from search indexes. This may be intentional (staging, private route) or an accidental leak from a dev template.`,
            evidence: [{ url, snippet: `<meta name="robots" content="${liveParsed.robotsMeta}">` }],
            remediation: "If this page is intended public content, remove the noindex directive. Confirm against Search Console URL Inspection that this is not the intended state.",
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "quick-win",
          });
        }
        const xRobots = page.headers.match(/^x-robots-tag:\s*(.+)$/im);
        if (xRobots && /noindex/i.test(xRobots[1])) {
          findings.push({
            id: "seo-aeo.x-robots-noindex",
            domain: DOMAIN,
            severity: "medium",
            title: "X-Robots-Tag: noindex in response headers",
            description: `Server emits \`X-Robots-Tag: ${xRobots[1].trim()}\`. A header-level noindex applies to the entire response and is easy to miss in template review. Often set by CDN/edge rules (Cloudflare-owned) or framework defaults.`,
            evidence: [{ url, snippet: `X-Robots-Tag: ${xRobots[1].trim()}` }],
            remediation: "If the page is intended public, remove the X-Robots-Tag noindex from the origin or edge configuration. Coordinate with whoever owns the CDN/edge layer.",
            source: "curl/headers",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "config",
          });
        }

        // ── Canonical ──
        if (multiPage && liveParsed && !liveParsed.canonical) {
          findings.push({
            id: "seo-aeo.missing-canonical",
            domain: DOMAIN,
            severity: "medium",
            title: "Missing canonical link on multi-page site",
            description: "No `<link rel=\"canonical\">` found. On multi-page sites, missing canonicals let duplicate URLs (UTM params, trailing-slash variants, case) split ranking signals and create index bloat. Single-page apps can often omit it; multi-page sites should not.",
            evidence: [{ url, snippet: "no <link rel=\"canonical\"> in <head>" }],
            remediation: "Add `<link rel=\"canonical\" href=\"<self-URL>\">` to the page head. For template-driven frameworks, set it from the current route.",
            agentPrompt: "Add `<link rel=\"canonical\" href=\"{current route URL}\">` to the <head>. Use the absolute self-referential URL for the current route.",
            references: ["https://developers.google.com/search/docs/crawling-indexing/consolidate-urls"],
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        }

        // ── Meta description ──
        if (liveParsed && (!liveParsed.metaDescription || liveParsed.metaDescription.length < 20)) {
          findings.push({
            id: "seo-aeo.missing-meta-description",
            domain: DOMAIN,
            severity: "low",
            title: "Missing or thin meta description",
            description: "No meaningful `<meta name=\"description\">` found. Google may auto-generate one from page content, but an explicit description improves snippet quality and answer-engine passage selection. Keep under ~155 chars.",
            evidence: [{ url, snippet: liveParsed.metaDescription ? `description="${liveParsed.metaDescription}"` : "no meta description" }],
            remediation: "Add a concise, unique meta description per page summarizing the primary content under ~155 characters.",
            references: ["https://developers.google.com/search/docs/appearance/snippet#meta-description"],
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        }

        // ── JSON-LD ──
        if (liveParsed && liveParsed.jsonLdBlocks === 0) {
          findings.push({
            id: "seo-aeo.missing-jsonld",
            domain: DOMAIN,
            severity: "low",
            title: "No JSON-LD structured data detected",
            description: "No `<script type=\"application/ld+json\">` blocks found. JSON-LD is the recommended format for Schema.org markup. It is not a ranking factor, but valid structured data that matches visible content enables rich results and helps answer engines interpret entities. Do not add schema that does not match the visible page.",
            evidence: [{ url, snippet: "0 JSON-LD blocks in <head>" }],
            remediation: "If the page represents a clear entity (Article, Product, Organization, FAQ, BreadcrumbList), add matching JSON-LD that mirrors visible content. Validate with the Rich Results Test.",
            references: ["https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data"],
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        }

        // ── H1 count ──
        if (liveParsed && liveParsed.h1Count === 0) {
          findings.push({
            id: "seo-aeo.missing-h1",
            domain: DOMAIN,
            severity: "low",
            title: "No <h1> heading on page",
            description: "No `<h1>` found in the rendered HTML. A single H1 per page communicates the primary topic to crawlers and assistive tech. (WCAG heading-order concerns are owned by Domain 9; this finding is about semantic structure for indexing.)",
            evidence: [{ url, snippet: "0 <h1> elements" }],
            remediation: "Add a single descriptive <h1> as the primary page heading.",
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        } else if (liveParsed && liveParsed.h1Count > 1) {
          findings.push({
            id: "seo-aeo.multiple-h1",
            domain: DOMAIN,
            severity: "info",
            title: `${liveParsed.h1Count} <h1> elements on page`,
            description: `Multiple H1s are not a hard error (HTML5 allows it), but a single H1 per page is the safest convention for topic signaling and avoids ambiguity for answer-engine passage extraction.`,
            evidence: [{ url, snippet: `${liveParsed.h1Count} <h1> elements` }],
            remediation: "If the H1s serve different sections, consider promoting one to H1 and demoting others to H2. Not required.",
            source: "curl/html",
            confidence: "high",
            verificationStatus: "verified",
            affectedFlow: "crawl",
            remediationClass: "code-change",
          });
        }

        // ── robots.txt + sitemap ──
        const origin = baseOrigin(url);
        if (origin) {
          const robotsUrl = `${origin}/robots.txt`;
          const robotsPage = fetchUrl(robotsUrl, 8000);
          if (!robotsPage || robotsPage.status === 404) {
            findings.push({
              id: "seo-aeo.missing-robots-txt",
              domain: DOMAIN,
              severity: "low",
              title: "No robots.txt at site root",
              description: "RFC 9309 specifies /robots.txt as the canonical crawler-policy file. Its absence means crawlers assume full crawl permission and you lose an explicit policy surface. Not a hard blocker, but a missing control.",
              evidence: [{ url: robotsUrl, snippet: "404 / no body" }],
              remediation: "Publish a /robots.txt. At minimum, reference your sitemap(s). Decide AI-bot policy explicitly rather than by omission.",
              references: ["https://www.rfc-editor.org/rfc/rfc9309"],
              source: "curl",
              confidence: "high",
              verificationStatus: "verified",
              affectedFlow: "crawl",
              remediationClass: "quick-win",
            });
          } else if (robotsPage.status === 200 && robotsPage.body) {
            const parsed = parseRobots(robotsPage.body);
            if (parsed.allDisallowed) {
              findings.push({
                id: "seo-aeo.robots-all-disallowed",
                domain: DOMAIN,
                severity: "high",
                title: "robots.txt disallows all crawling (User-agent: * Disallow: /)",
                description: "The site-wide robots.txt blocks all crawlers. This will remove the entire site from search indexes. Confirm this is intended (e.g., pre-launch) and not a staging template leaked to production.",
                evidence: [{ url: robotsUrl, snippet: "User-agent: *\nDisallow: /" }],
                remediation: "If the site is intended public, remove or restrict the Disallow: / rule. If staging, ensure production deployment does not carry it.",
                references: ["https://www.rfc-editor.org/rfc/rfc9309"],
                source: "curl",
                confidence: "high",
                verificationStatus: "verified",
                affectedFlow: "crawl",
                remediationClass: "quick-win",
              });
            }
            // Sitemap validation
            if (parsed.sitemaps.length === 0) {
              findings.push({
                id: "seo-aeo.no-sitemap-reference",
                domain: DOMAIN,
                severity: "low",
                title: "robots.txt declares no sitemap",
                description: "No `Sitemap:` directive in robots.txt. Sitemaps are not required, but they help crawlers discover URLs (especially new, isolated, or JS-rendered pages). For multi-page sites, declare at least one.",
                evidence: [{ url: robotsUrl, snippet: "no Sitemap: directive" }],
                remediation: "Generate a sitemap.xml and reference it via `Sitemap: <absolute-url>` in robots.txt. Many frameworks auto-generate this.",
                references: ["https://www.sitemaps.org/protocol.html"],
                source: "curl",
                confidence: "high",
                verificationStatus: "verified",
                affectedFlow: "crawl",
                remediationClass: "config",
              });
            } else {
              for (const sm of parsed.sitemaps) {
                const smResp = fetchOnly(sm, 8000);
                if (!smResp || smResp.status >= 400) {
                  findings.push({
                    id: `seo-aeo.broken-sitemap.${Buffer.from(sm).toString("base64url").slice(0, 12)}`,
                    domain: DOMAIN,
                    severity: "medium",
                    title: `Sitemap unreachable: ${sm}`,
                    description: `robots.txt references a sitemap at \`${sm}\` that returns ${smResp ? `HTTP ${smResp.status}` : "no response"}. A declared-but-broken sitemap is worse than none — it wastes crawl budget and signals neglect.`,
                    evidence: [{ url: sm, snippet: smResp ? `HTTP ${smResp.status}` : "fetch failed" }],
                    remediation: "Either generate the sitemap at the declared URL or remove the Sitemap: directive from robots.txt.",
                    references: ["https://www.sitemaps.org/protocol.html"],
                    source: "curl",
                    confidence: "high",
                    verificationStatus: "verified",
                    affectedFlow: "crawl",
                    remediationClass: "config",
                  });
                }
              }
            }
            // AI-bot policy note
            if (parsed.aiBots.length > 0) {
              manual.push({
                item: `Confirm AI-bot policy intent for: ${parsed.aiBots.join(", ")}`,
                rationale: "robots.txt sets explicit Allow/Disallow for AI crawlers. Automation can detect the directives but cannot confirm whether the chosen policy (training-permitted vs training-blocked vs search-only) matches owner intent. GPTBot/OAI-SearchBot (training vs search), ClaudeBot/Claude-SearchBot/Claude-User, CCBot, etc. serve different purposes.",
              });
            } else {
              manual.push({
                item: "Decide and document AI-bot policy (training vs search vs user-fetch)",
                rationale: "robots.txt has no explicit AI-bot directives, meaning all AI crawlers are allowed by default (per RFC 9309, omission = allow). The owner should consciously decide whether training crawlers (GPTBot, CCBot, ClaudeBot, Google-Extended) are permitted and set directives accordingly. This is a policy decision, not a defect.",
              });
            }
          }
        }
      }
    } else {
      coverageStatus = "partial";
      coverageReason = "no audit URL provided; repo heuristics only — live crawl/index signals not verified";
    }

    // ── Repo heuristics (always run if repoPath present) ─────────────
    if (repoPath) {
      // llms.txt presence — informational, NOT a citation mechanism
      const llmsTxt = existsSync(join(repoPath, "public", "llms.txt")) ||
        existsSync(join(repoPath, "static", "llms.txt")) ||
        existsSync(join(repoPath, "llms.txt"));
      if (llmsTxt) {
        findings.push({
          id: "seo-aeo.llms-txt-present",
          domain: DOMAIN,
          severity: "info",
          title: "llms.txt file present in repo",
          description: "An `llms.txt` file exists. Note: llms.txt is a community proposal, not a web standard, and is NOT a citation mechanism or ranking factor for Google, Bing, or answer engines. Treating it as a substitute for clear headings, structured data, and crawlable content is a known anti-pattern. Its presence is fine if used as documentation for LLM tooling; do not assume it influences indexing or citation.",
          remediation: "No action required. If llms.txt was added expecting a search/answer-engine benefit, redirect that effort to clear content structure, valid structured data, and crawlable HTML.",
          source: "filesystem",
          confidence: "high",
          verificationStatus: "verified",
          remediationClass: "quick-win",
        });
      }

      // Scan templates for missing head elements (heuristic; supplements live fetch)
      const templates = walkRepo(repoPath, (rel) => isTemplate(rel), { maxFiles: 1500 });
      if (templates.length > 0) {
        const titleHits = grepFiles(templates, /<title[\s>]/i, { maxMatches: 50 });
        const descHits = grepFiles(templates, /<meta\s+name=["']description["']/i, { maxMatches: 50 });
        const canonHits = grepFiles(templates, /<link\s+rel=["']canonical["']/i, { maxMatches: 50 });
        const jsonLdHits = grepFiles(templates, /<script\s+type=["']application\/ld\+json["']/i, { maxMatches: 50 });
        const noindexHits = grepFiles(templates, /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i, { maxMatches: 50 });
        const ogHits = grepFiles(templates, /<meta\s+property=["']og:(title|description|image)["']/i, { maxMatches: 50 });

        // Only emit repo-heuristic findings that are NOT already covered by the live fetch.
        // The live path is authoritative; repo findings are supplemental and marked heuristic.
        if (!url) {
          if (titleHits.length === 0) {
            findings.push({
              id: "seo-aeo.repo-missing-title",
              domain: DOMAIN,
              severity: "medium",
              title: "No <title> found in any page template",
              description: "Static scan of HTML/JSX/TSX/MDX templates found no `<title>` element. Without a live URL this is a heuristic; some frameworks inject titles at runtime. Verify with a rendered fetch.",
              evidence: titleHits.slice(0, 3).map((h) => ({ file: h.file, line: h.line, snippet: h.snippet })),
              remediation: "Add a `<title>` to the root layout or per-page head. Confirm via a rendered fetch that it appears in served HTML.",
              source: "filesystem/grep",
              confidence: "medium",
              verificationStatus: "heuristic",
              remediationClass: "code-change",
            });
          }
          if (descHits.length === 0) {
            findings.push({
              id: "seo-aeo.repo-missing-meta-description",
              domain: DOMAIN,
              severity: "low",
              title: "No meta description found in any page template",
              description: "Static scan found no `<meta name=\"description\">`. Some frameworks inject meta at runtime; confirm with a rendered fetch.",
              evidence: descHits.slice(0, 3).map((h) => ({ file: h.file, line: h.line, snippet: h.snippet })),
              remediation: "Add per-page meta descriptions to the layout or page head.",
              source: "filesystem/grep",
              confidence: "medium",
              verificationStatus: "heuristic",
              remediationClass: "code-change",
            });
          }
          if (multiPage && canonHits.length === 0) {
            findings.push({
              id: "seo-aeo.repo-missing-canonical",
              domain: DOMAIN,
              severity: "medium",
              title: "No canonical link found in any page template (multi-page site)",
              description: "Static scan found no `<link rel=\"canonical\">` and the repo looks multi-page. Missing canonicals risk duplicate-URL index bloat. Confirm with a rendered fetch.",
              evidence: canonHits.slice(0, 3).map((h) => ({ file: h.file, line: h.line, snippet: h.snippet })),
              remediation: "Add `<link rel=\"canonical\">` to the root layout, set from the current route.",
              source: "filesystem/grep",
              confidence: "medium",
              verificationStatus: "heuristic",
              remediationClass: "code-change",
            });
          }
          if (jsonLdHits.length === 0) {
            findings.push({
              id: "seo-aeo.repo-missing-jsonld",
              domain: DOMAIN,
              severity: "low",
              title: "No JSON-LD structured data in any template",
              description: "Static scan found no JSON-LD blocks. JSON-LD is not a ranking factor but helps answer engines interpret entities when it matches visible content. Confirm with a rendered fetch — some sites inject it at runtime.",
              evidence: jsonLdHits.slice(0, 3).map((h) => ({ file: h.file, line: h.line, snippet: h.snippet })),
              remediation: "If the page represents a clear entity, add matching JSON-LD. Validate with the Rich Results Test.",
              source: "filesystem/grep",
              confidence: "medium",
              verificationStatus: "heuristic",
              remediationClass: "code-change",
            });
          }
          if (ogHits.length === 0) {
            findings.push({
              id: "seo-aeo.repo-missing-og",
              domain: DOMAIN,
              severity: "low",
              title: "No Open Graph tags found in templates",
              description: "No `og:title`, `og:description`, or `og:image` found. OG tags control link previews on social/answer surfaces. Not a search ranking factor, but affects referral click-through and snippet quality on platforms that read them.",
              evidence: ogHits.slice(0, 3).map((h) => ({ file: h.file, line: h.line, snippet: h.snippet })),
              remediation: "Add og:title, og:description, og:image to the page head. Many frameworks provide a helper.",
              source: "filesystem/grep",
              confidence: "medium",
              verificationStatus: "heuristic",
              remediationClass: "code-change",
            });
          }
        }

        // noindex hits are worth flagging even WITH a live URL — they identify the template source
        for (const hit of noindexHits.slice(0, 5)) {
          findings.push({
            id: `seo-aeo.repo-noindex-template.${Buffer.from(hit.file).toString("base64url").slice(0, 12)}`,
            domain: DOMAIN,
            severity: "low",
            title: `noindex directive in template: ${hit.file.split("/").slice(-2).join("/")}`,
            description: "A page template emits a noindex robots meta. This is correct for staging/private pages but a defect if leaked to production public routes. Confirm the template is not used for intended-public pages.",
            evidence: [{ file: hit.file, line: hit.line, snippet: hit.snippet }],
            remediation: "If this template renders public content, remove the noindex. If it's a staging/private template, ensure production builds don't import it.",
            source: "filesystem/grep",
            confidence: "medium",
            verificationStatus: "heuristic",
            remediationClass: "code-change",
          });
        }
      }
    }

    // ── Lighthouse SEO (optional; rendered parity) ───────────────────
    if (url && lh.available) {
      toolsUsed.push("lighthouse");
      const lhRes = runCommand(
        "lighthouse",
        [url, "--only-categories=seo", "--output=json", "--quiet", "--chrome-flags=--headless --no-sandbox --disable-gpu", "--max-wait-for-load=45000"],
        { timeoutMs: 120_000 },
      );
      if (lhRes.status === 0 && lhRes.stdout) {
        try {
          const lh = JSON.parse(lhRes.stdout);
          const seoScore: number | undefined = lh.categories?.seo?.score;
          // Lighthouse SEO audits — surface failures only, avoid duplicating our own checks
          const audits = lh.audits || {};
          const failed = Object.entries(audits)
            .filter(([, a]: [string, any]) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "notApplicable")
            .map(([id, a]: [string, any]) => ({ id, title: a.title, desc: a.description }));
          if (failed.length > 0) {
            // Render parity: Lighthouse runs a real browser; if its findings differ from our raw curl,
            // that signals a JS-rendered content gap.
            manual.push({
              item: "Compare raw-curl findings to Lighthouse (rendered) findings for render parity",
              rationale: `Lighthouse ran a headless browser and surfaced ${failed.length} SEO audit(s). If Lighthouse sees content our raw curl did not (e.g. title/canonical injected by JS), the site relies on client-side rendering and may not be indexable by crawlers that don't render JS. Google renders JS but with a delay; answer-engine fetchers vary.`,
              critical: true,
            });
            for (const f of failed.slice(0, 5)) {
              findings.push({
                id: `seo-aeo.lighthouse.${f.id}`,
                domain: DOMAIN,
                severity: f.id === "viewport" || f.id === "document-title" ? "high" : "medium",
                title: `Lighthouse SEO: ${f.title}`,
                description: `${f.desc} (Lighthouse audit: ${f.id})`,
                evidence: [{ url, snippet: `lighthouse seo audit ${f.id}` }],
                remediation: "See Lighthouse audit guidance for this item. Lighthouse runs a rendered fetch, so its findings reflect what a JS-capable crawler sees.",
                source: "lighthouse",
                confidence: "high",
                verificationStatus: "verified",
                affectedFlow: "render",
                remediationClass: "code-change",
              });
            }
          }
          if (typeof seoScore === "number") {
            // Don't emit a finding for the score itself (per evidence standard — scores are leads only)
            // but note it for transparency in coverage reason
            coverageReason = (coverageReason ? coverageReason + "; " : "") + `lighthouse seo score ${Math.round(seoScore * 100)}`;
          }
        } catch {
          toolsMissing.push("lighthouse (json parse failed)");
        }
      } else {
        toolsMissing.push("lighthouse (run failed; likely no chrome)");
      }
    } else if (url) {
      manual.push({
        item: "Verify rendered-vs-raw HTML parity (Lighthouse unavailable)",
        rationale: "Lighthouse is not installed, so this audit could not run a headless render. For JS-heavy sites, the raw-curl HTML may differ from what a rendered crawler sees. Manually fetch the page with JS disabled and compare — if title/canonical/content are missing without JS, the site is not reliably indexable.",
        critical: true,
      });
      coverageStatus = coverageStatus === "pass" ? "partial" : coverageStatus;
      coverageReason = (coverageReason ? coverageReason + "; " : "") + "rendered parity unverified (no lighthouse)";
    }

    // ── Always-on manual checklist ───────────────────────────────────
    if (url) {
      manual.push({
        item: "Verify index coverage and canonical selection in Search Console / Bing Webmaster Tools",
        rationale: "Automation can detect directives but cannot see actual index status, canonical selection, or crawl frequency. These are observable only in first-party console data. Check the URL Inspection tool for the audit URL.",
        critical: true,
      });
    }
    manual.push({
      item: "Confirm structured data (if present) matches visible page content",
      rationale: "Schema that does not mirror visible content is a spam signal and can trigger manual action. The Rich Results Test validates syntax; only a human can confirm semantic match against the rendered page.",
    });

    const durationMs = Date.now() - start;
    return {
      domain: DOMAIN,
      ranAt: new Date().toISOString(),
      durationMs,
      toolsUsed,
      toolsMissing,
      findings,
      manualChecklist: manual,
      coverage: { status: coverageStatus, reason: coverageReason },
    };
  },
};

export default seoAeoCheck;
