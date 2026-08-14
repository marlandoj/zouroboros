#!/usr/bin/env bun
// Weekly drift audit: lints DESIGN.md and diffs declared tokens vs live site CSS.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

type Project = { slug: string; name: string; designMd: string; siteCss: string[]; exemptScopes?: string[] };
type LintFinding = { severity: string; path?: string; message: string };
type LintReport = { findings: LintFinding[]; summary: { errors: number; warnings: number; infos: number } };
type Drift = {
  declaredOnly: Array<{ token: string; hex: string }>;
  siteOnly: string[];
  mismatches: Array<{ token: string; declared: string; site: string }>;
};
type ProjectResult = {
  slug: string;
  name: string;
  designMd: string;
  lint: LintReport | { error: string };
  drift: Drift;
  siteFilesChecked: string[];
};

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has("--json");
const FAIL_ON_ERROR = ARGS.has("--fail-on-error");
const projectFilter = (() => {
  const i = process.argv.indexOf("--project");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const CONFIG_PATH = join(import.meta.dir, "projects.json");
const REPORTS_DIR = join(import.meta.dir, "..", "reports");

function loadProjects(): Project[] {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const list: Project[] = cfg.projects;
  return projectFilter ? list.filter((p) => p.slug === projectFilter) : list;
}

function parseDesignColors(path: string): Map<string, string> {
  const src = readFileSync(path, "utf8");
  const fmMatch = src.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return new Map();
  const fm = fmMatch[1];
  // Capture the colors: block — everything indented under it, stopping at the
  // next top-level YAML key (a line that starts with a letter at column 0) or
  // end of the frontmatter string.
  const colorsBlock = ("\n" + fm).match(/\ncolors:\n((?:[ \t]+[^\n]*\n?)+)/);
  if (!colorsBlock) return new Map();
  const colors = new Map<string, string>();
  const oklchValRe = /oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*[0-9.]+\s*)?\)/i;
  for (const line of colorsBlock[1].split("\n")) {
    const hexM = line.match(/^\s+([a-zA-Z0-9_-]+):\s*"?(#[0-9A-Fa-f]{3,8})"?/);
    if (hexM) { colors.set(hexM[1], hexM[2].toUpperCase()); continue; }
    const oklchLineM = line.match(/^\s+([a-zA-Z0-9_-]+):\s*"?(oklch\([^)]+\))"?/i);
    if (oklchLineM) {
      const inner = oklchLineM[2].match(oklchValRe);
      if (inner) {
        let L = parseFloat(inner[1]);
        if (inner[2] === "%") L /= 100;
        const C = parseFloat(inner[3]);
        const H = parseFloat(inner[4]);
        if (Number.isFinite(L) && Number.isFinite(C) && Number.isFinite(H))
          colors.set(oklchLineM[1], oklchToHex(L, C, H));
      }
    }
  }
  return colors;
}

function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const rL = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gL = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bL = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const toSrgb = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(toSrgb(v) * 255)));
  return (
    "#" +
    [ch(rL), ch(gL), ch(bL)]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

// Remove CSS blocks whose top-level selector starts with an exempt scope prefix.
// Uses brace-depth tracking so nested rules inside a scoped block are removed too.
export function stripExemptScopes(css: string, exemptScopes: string[]): string {
  let result = css;
  for (const scope of exemptScopes) {
    const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped + "(?=\\s|[.#:\\[>+~,]|\\{)[^{}]*\\{", "g");
    let out = "";
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(result)) !== null) {
      let depth = 1;
      let pos = m.index + m[0].length;
      while (pos < result.length && depth > 0) {
        if (result[pos] === "{") depth++;
        else if (result[pos] === "}") depth--;
        pos++;
      }
      out += result.slice(lastEnd, m.index);
      lastEnd = pos;
    }
    result = out + result.slice(lastEnd);
  }
  return result;
}

function extractHexFromCss(path: string, exemptScopes?: string[]): Set<string> {
  if (!existsSync(path)) return new Set();
  // Strip CSS comments first — spec hex annotations like
  //   --color-amber: oklch(...) /* #D4A017 */
  // would otherwise be matched as if the hex was a real declaration.
  let src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  if (exemptScopes?.length) src = stripExemptScopes(src, exemptScopes);
  const hexes = new Set<string>();
  for (const m of src.matchAll(/#([0-9A-Fa-f]{6})\b/g)) {
    hexes.add(`#${m[1].toUpperCase()}`);
  }
  // oklch(L C H) with optional percent / alpha / slashes. Values are numbers,
  // optionally suffixed with `%` for L. Matches forms like:
  //   oklch(0.96 0.01 85)
  //   oklch(96% 0.01 85)
  //   oklch(0.577 0.245 27.325)
  //   oklch(1 0 0 / 0.5)
  const oklchRe = /oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*[0-9.]+\s*)?\)/gi;
  for (const m of src.matchAll(oklchRe)) {
    let L = parseFloat(m[1]);
    if (m[2] === "%") L = L / 100;
    const C = parseFloat(m[3]);
    const H = parseFloat(m[4]);
    if (!Number.isFinite(L) || !Number.isFinite(C) || !Number.isFinite(H)) continue;
    hexes.add(oklchToHex(L, C, H));
  }
  return hexes;
}

function lintDesignMd(path: string): LintReport | { error: string } {
  try {
    const raw = execSync(
      `npx -y @google/design.md lint ${JSON.stringify(path)}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp" }
    );
    const jsonStart = raw.indexOf("{");
    return JSON.parse(raw.slice(jsonStart));
  } catch (e: any) {
    const out = (e.stdout || "").toString();
    const jsonStart = out.indexOf("{");
    if (jsonStart >= 0) {
      try {
        return JSON.parse(out.slice(jsonStart));
      } catch {}
    }
    return { error: (e.message || String(e)).slice(0, 500) };
  }
}

function computeDrift(declared: Map<string, string>, siteHexes: Set<string>): Drift {
  const declaredHexes = new Set(Array.from(declared.values()));
  const declaredOnly: Array<{ token: string; hex: string }> = [];
  for (const [token, hex] of declared) {
    if (!siteHexes.has(hex)) declaredOnly.push({ token, hex });
  }
  const siteOnly = Array.from(siteHexes).filter((h) => !declaredHexes.has(h)).sort();
  return { declaredOnly, siteOnly, mismatches: [] };
}

function renderMarkdown(results: ProjectResult[]): string {
  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`# DESIGN.md Drift Report — ${today}`, "");
  const totalErrors = results.reduce(
    (n, r) => n + ("findings" in r.lint ? r.lint.summary.errors : 1),
    0
  );
  const totalDrift = results.reduce((n, r) => n + r.drift.declaredOnly.length, 0);
  const totalExtras = results.reduce((n, r) => n + r.drift.siteOnly.length, 0);
  const statusEmoji = totalErrors > 0 ? "❌" : totalDrift > 0 ? "⚠️" : "✅";
  lines.push(
    `**Status:** ${statusEmoji} ${totalErrors} spec errors · ${totalDrift} declared-vs-site drift · ${totalExtras} extra site hexes (informational)`,
    ""
  );
  for (const r of results) {
    lines.push(`## ${r.name} (\`${r.slug}\`)`, "");
    lines.push(`- DESIGN.md: \`${r.designMd}\``);
    if ("error" in r.lint) {
      lines.push(`- **Lint error:** ${r.lint.error}`);
    } else {
      const s = r.lint.summary;
      lines.push(`- Spec lint: ${s.errors} errors · ${s.warnings} warnings · ${s.infos} infos`);
      for (const f of r.lint.findings.filter((x) => x.severity === "error" || x.severity === "warning")) {
        lines.push(`  - **${f.severity}** ${f.path ?? ""} — ${f.message}`);
      }
    }
    lines.push(`- Site files checked: ${r.siteFilesChecked.map((f) => `\`${f}\``).join(", ") || "_none_"}`);
    if (r.drift.declaredOnly.length > 0) {
      lines.push(`- **Declared in DESIGN.md but not present in site CSS:**`);
      for (const d of r.drift.declaredOnly) lines.push(`  - \`${d.token}\` (${d.hex})`);
    }
    if (r.drift.declaredOnly.length === 0) {
      lines.push(`- ✅ All declared DESIGN.md colors are present in site CSS.`);
    }
    if (r.drift.siteOnly.length > 0) {
      lines.push(
        `- _Extra hex values in site CSS not declared in DESIGN.md (informational — may be impl details, dark-mode, charts):_ ${r.drift.siteOnly.join(", ")}`
      );
    }
    lines.push("");
  }
  lines.push("---");
  lines.push(`_Generated by \`Skills/design-md-drift-guard\`._`);
  return lines.join("\n");
}

function main() {
  const projects = loadProjects();
  const results: ProjectResult[] = [];
  for (const p of projects) {
    const declared = parseDesignColors(p.designMd);
    const siteHexes = new Set<string>();
    const filesChecked: string[] = [];
    for (const css of p.siteCss) {
      const hexes = extractHexFromCss(css, p.exemptScopes);
      if (hexes.size > 0) {
        filesChecked.push(css);
        for (const h of hexes) siteHexes.add(h);
      }
    }
    results.push({
      slug: p.slug,
      name: p.name,
      designMd: p.designMd,
      lint: lintDesignMd(p.designMd),
      drift: computeDrift(declared, siteHexes),
      siteFilesChecked: filesChecked,
    });
  }

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const mdPath = join(REPORTS_DIR, `drift-${today}.md`);
  const jsonPath = join(REPORTS_DIR, `drift-${today}.json`);
  const md = renderMarkdown(results);
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, JSON.stringify({ date: today, results }, null, 2));

  if (JSON_OUT) {
    console.log(JSON.stringify({ date: today, results, mdPath, jsonPath }, null, 2));
  } else {
    console.log(md);
    console.log(`\nReports saved:\n  ${mdPath}\n  ${jsonPath}`);
  }

  if (FAIL_ON_ERROR) {
    const hasErrors = results.some(
      (r) =>
        ("findings" in r.lint && r.lint.summary.errors > 0) ||
        r.drift.declaredOnly.length > 0
    );
    process.exit(hasErrors ? 1 : 0);
  }
}

if (import.meta.main) main();
