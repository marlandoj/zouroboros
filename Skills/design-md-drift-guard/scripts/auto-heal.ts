#!/usr/bin/env bun
// Auto-heal mechanical DESIGN.md drift.
//
// Mechanical drift = a color declared in DESIGN.md whose hex is NOT in site CSS,
// but the site CSS contains exactly one OKLCH-form variable declaration whose
// rendered hex is within RGB tolerance of the spec hex. The fix is to replace
// the OKLCH source line with the literal spec hex.
//
// Anything else (WCAG warnings, missing slots, multi-candidate ambiguity,
// rogue hexes) is a JUDGMENT call and surfaced for human review — never
// auto-applied.
//
// Usage:
//   bun auto-heal.ts                  # dry-run, prints proposed edits
//   bun auto-heal.ts --apply          # write edits in place
//   bun auto-heal.ts --apply --consensus  # gate edits through BGP consensus before applying
//   bun auto-heal.ts --json           # machine-readable plan
//   bun auto-heal.ts --apply --consensus  # gate edits through consensus before applying
//   bun auto-heal.ts --project <slug> # restrict to one project

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";

export type Project = { slug: string; name: string; designMd: string; siteCss: string[] };
export type DriftItem = { token: string; hex: string };
export type GuardResult = {
  slug: string;
  name: string;
  designMd: string;
  lint: any;
  drift: { declaredOnly: DriftItem[]; siteOnly: string[]; mismatches: any[] };
  siteFilesChecked: string[];
};

export type Edit = {
  file: string;
  lineNumber: number;
  oldLine: string;
  newLine: string;
  varName: string;
  specToken: string;
  specHex: string;
  renderedHex: string;
  rgbDistance: number;
};

export type ProjectPlan = {
  slug: string;
  name: string;
  edits: Edit[];
  judgmentCalls: string[];
};

const ARGS = new Set(process.argv.slice(2));
const APPLY = ARGS.has("--apply");
const CONSENSUS = ARGS.has("--consensus");
const JSON_OUT = ARGS.has("--json");
const projectFilter = (() => {
  const i = process.argv.indexOf("--project");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const SKILL_DIR = "/home/workspace/Skills/design-md-drift-guard";
const GUARD = join(SKILL_DIR, "scripts", "drift-guard.ts");
const CONFIG = join(SKILL_DIR, "scripts", "projects.json");

// Tight tolerance for mechanical auto-fix: only rounding/encoding drift
// (perceptually identical). Wider tolerance is used to surface "close but
// not identical" approximation drift as a judgment call.
const AUTO_TOLERANCE = 5;
const NEAR_TOLERANCE = 35;

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

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/^([0-9A-Fa-f]{6})$/);
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16),
  ];
}

function rgbDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

// Match a CSS variable declaration whose value is a single oklch(...) call,
// optionally followed by `;` and a trailing /* … */ comment. Inline OKLCH
// inside gradients, derived colors, or property declarations is NOT matched.
const VAR_OKLCH_LINE =
  /^(\s*)(--[\w-]+)\s*:\s*oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*[0-9.]+)?\s*\)\s*;\s*(\/\*[^*]*\*\/)?\s*$/;

export function loadGuardJson(): { date: string; results: GuardResult[] } {
  const raw = execSync(`bun ${JSON.stringify(GUARD)} --json`, { encoding: "utf8" });
  return JSON.parse(raw);
}

export function planForProject(p: GuardResult, projects: Project[]): ProjectPlan {
  const proj = projects.find((x) => x.slug === p.slug)!;
  const plan: ProjectPlan = { slug: p.slug, name: p.name, edits: [], judgmentCalls: [] };

  // Surface only actionable lint findings. WCAG contrast and spec errors are
  // judgment calls the human must resolve. "Never referenced" warnings are
  // spec-completeness noise (declared slot, no component binding) and visible
  // in the full report — we don't enumerate them in the digest.
  if ("findings" in p.lint) {
    for (const f of p.lint.findings) {
      if (/contrast ratio/i.test(f.message)) {
        plan.judgmentCalls.push(`${p.slug} WCAG: ${f.path ?? ""} — ${f.message}`);
      } else if (f.severity === "error") {
        plan.judgmentCalls.push(`${p.slug} spec error: ${f.path ?? ""} — ${f.message}`);
      }
    }
  }

  // Rogue site hexes: only flag when the count crosses a threshold worth a
  // human glance. Below that, it's almost always sanctioned impl detail
  // (chart palette, framework greys) and the noise drowns out real findings.
  if (p.drift.siteOnly.length > 25) {
    plan.judgmentCalls.push(
      `${p.slug} ${p.drift.siteOnly.length} extra site hex value(s) not in DESIGN.md — large count, review for missing slots`
    );
  }

  if (p.drift.declaredOnly.length === 0) {
    return plan;
  }
  const dedupePlan = () => {
    // Two declared tokens can share a hex (e.g. on-primary == background)
    // and resolve to the same OKLCH source line. Collapse to one edit.
    const seen = new Set<string>();
    plan.edits = plan.edits.filter((e) => {
      const key = `${e.file}:${e.lineNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Try to mechanically heal each missing declared color.
  for (const css of proj.siteCss) {
    const src = readFileSync(css, "utf8");

    // Defensive: if any oklch(from var(...)) derived-color references exist in
    // the file, refuse to auto-heal — replacing the source variable with a hex
    // literal could change downstream renders.
    if (/oklch\(\s*from\s+var\(/.test(src)) {
      plan.judgmentCalls.push(
        `${p.slug} site CSS uses oklch(from var(...)) derived colors — auto-heal disabled for safety: ${css}`
      );
      continue;
    }

    // Strip block comments by replacing them with same-length whitespace
    // (preserving newlines and column positions) so a `/* ... --foo: oklch(...) ... */`
    // block can't be matched as a real var declaration. Drift-guard does the
    // same on its hex-extraction pass; matching that behavior here.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (match) =>
      match.replace(/[^\n]/g, " ")
    );
    const lines = src.split("\n");
    const scanLines = stripped.split("\n");
    for (const missing of p.drift.declaredOnly) {
      const candidates: Array<{
        idx: number;
        line: string;
        indent: string;
        varName: string;
        renderedHex: string;
        distance: number;
      }> = [];
      for (let i = 0; i < scanLines.length; i++) {
        const m = scanLines[i].match(VAR_OKLCH_LINE);
        if (!m) continue;
        let L = parseFloat(m[3]);
        if (m[4] === "%") L = L / 100;
        const C = parseFloat(m[5]);
        const H = parseFloat(m[6]);
        const renderedHex = oklchToHex(L, C, H);
        const dist = rgbDistance(renderedHex, missing.hex);
        if (dist <= NEAR_TOLERANCE) {
          candidates.push({
            idx: i,
            line: lines[i],
            indent: m[1],
            varName: m[2],
            renderedHex,
            distance: dist,
          });
        }
      }
      const tight = candidates.filter((c) => c.distance <= AUTO_TOLERANCE);
      if (tight.length === 1) {
        const c = tight[0];
        const newLine = `${c.indent}${c.varName}: ${missing.hex};`;
        plan.edits.push({
          file: css,
          lineNumber: c.idx + 1,
          oldLine: c.line,
          newLine,
          varName: c.varName,
          specToken: missing.token,
          specHex: missing.hex,
          renderedHex: c.renderedHex,
          rgbDistance: Math.round(c.distance * 10) / 10,
        });
      } else if (tight.length > 1) {
        plan.judgmentCalls.push(
          `${p.slug} declared "${missing.token}" (${missing.hex}) has ${tight.length} OKLCH lines that round to it — ambiguous, manual choice needed`
        );
      } else if (candidates.length > 0) {
        // No tight match (>5Δ from all candidates). Show up to 3 closest
        // OKLCH vars so the human can judge which (if any) is the intended
        // source. Closeness alone is not proof of correlation — a neutral
        // grey may sit near a bone-white spec by coincidence.
        const sorted = candidates.slice().sort((a, b) => a.distance - b.distance);
        const top = sorted
          .slice(0, 3)
          .map((c) => `${c.varName}→${c.renderedHex} (Δ${Math.round(c.distance)})`)
          .join(", ");
        plan.judgmentCalls.push(
          `${p.slug} declared "${missing.token}" (${missing.hex}): no OKLCH source within auto-fix tolerance. Nearby vars (≤35Δ): ${top}. Investigate which var was intended for this token, or add a literal hex declaration.`
        );
      } else {
        plan.judgmentCalls.push(
          `${p.slug} declared "${missing.token}" (${missing.hex}) has no nearby OKLCH source — likely missing slot entirely`
        );
      }
    }
  }
  dedupePlan();
  return plan;
}

export function applyEdits(edits: Edit[]): void {
  // Group edits by file, sort by lineNumber descending so that earlier edits
  // don't shift the indices of later ones.
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file)!.push(e);
  }
  for (const [file, list] of byFile) {
    list.sort((a, b) => b.lineNumber - a.lineNumber);
    const lines = readFileSync(file, "utf8").split("\n");
    for (const e of list) {
      if (lines[e.lineNumber - 1] !== e.oldLine) {
        throw new Error(
          `auto-heal: line ${e.lineNumber} in ${file} no longer matches expected content; aborting to avoid corrupt edit`
        );
      }
      lines[e.lineNumber - 1] = e.newLine;
    }
    writeFileSync(file, lines.join("\n"));
  }
}

function main() {
  const cfg: { projects: Project[] } = JSON.parse(readFileSync(CONFIG, "utf8"));
  const projects = projectFilter
    ? cfg.projects.filter((p) => p.slug === projectFilter)
    : cfg.projects;

  const guard = loadGuardJson();
  const results = projectFilter
    ? guard.results.filter((r) => r.slug === projectFilter)
    : guard.results;

  const plans = results.map((r) => planForProject(r, projects));

  if (APPLY) {
    if (CONSENSUS) {
      const allEdits = plans.flatMap((p) => p.edits);
      if (allEdits.length > 0) {
        console.log(`\n🔒 Running BGP consensus gate on ${allEdits.length} edits...`);
        const tmpFile = `${tmpdir()}/design-md-plan-${Date.now()}.json`;
        writeFileSync(tmpFile, JSON.stringify(plans, null, 2));
        try {
          const result = execSync(
            `cd /home/workspace/Skills/consensus-gate/scripts && bun run consensus-gate.ts validate --file "${tmpFile}" --criteria "correctness,design" --label "design-md-autoheal"`,
            { timeout: 30000, encoding: "utf-8" }
          );
          const stdout = result.trim();
          if (stdout.includes("PASSED")) {
            console.log("✅ Consensus gate passed — applying edits.");
          } else if (stdout.includes("ESCALATE")) {
            console.error("⚠️  Consensus gate ESCALATED — applying with caution.");
          } else {
            console.error("❌ Consensus gate REJECTED the auto-heal plan. Aborting.");
            console.error(stdout.split("\n").slice(-10).join("\n"));
            process.exit(2);
          }
        } catch (e: any) {
          console.error("⚠️  BGP gate error:", e.message, "— applying without gating.");
        } finally {
          try { unlinkSync(tmpFile); } catch {}
        }
      }
    }
    for (const plan of plans) {
      if (plan.edits.length > 0) applyEdits(plan.edits);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ date: guard.date, applied: APPLY, plans }, null, 2));
    return;
  }

  for (const plan of plans) {
    console.log(`\n## ${plan.name} (${plan.slug})`);
    if (plan.edits.length === 0 && plan.judgmentCalls.length === 0) {
      console.log("  ✅ clean — no action needed");
      continue;
    }
    if (plan.edits.length > 0) {
      console.log(
        `  ${APPLY ? "Applied" : "Proposed"} ${plan.edits.length} mechanical fix(es):`
      );
      for (const e of plan.edits) {
        console.log(
          `    ${e.file}:${e.lineNumber} — ${e.varName}: ${e.renderedHex} → ${e.specHex} (token "${e.specToken}", Δ${e.rgbDistance})`
        );
      }
    }
    if (plan.judgmentCalls.length > 0) {
      console.log(`  ⚠ ${plan.judgmentCalls.length} judgment call(s) (no auto-fix):`);
      for (const j of plan.judgmentCalls) console.log(`    - ${j}`);
    }
  }
}

if (import.meta.main) main();
