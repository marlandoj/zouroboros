#!/usr/bin/env bun
/**
 * Capability-Ethics Ratio (R5 — zouroboros-governance-safety).
 *
 * Scans Skills/ and reports, per skill: does GOVERNANCE.md exist? The rollup
 * is the fraction of skills with governance documentation.
 *
 * Outputs JSON by default so the /api/capability-ethics surface and any
 * downstream tooling (observatory, agents) can consume it directly.
 *
 *   bun capability-ethics.ts                 # JSON to stdout
 *   bun capability-ethics.ts --pretty        # human-readable table
 *   bun capability-ethics.ts --skills-dir X  # override the scan root
 *
 * Notes:
 *  - The script intentionally does NOT mass-rewrite skills to add the file.
 *    The rollup itself is the nudge; adoption is voluntary and per-skill.
 *  - Hidden directories (`.git`, `_candidates`, `__pycache__`) are skipped.
 *  - Symlinks are followed only one level to avoid loops.
 */
import { parseArgs } from "util";
import * as fs from "node:fs";
import * as path from "node:path";

const { values } = parseArgs({
  options: {
    "skills-dir": { type: "string" as const, default: "/home/workspace/Skills" },
    pretty: { type: "boolean" as const, default: false },
  },
  allowPositionals: true,
});

const SKILLS_DIR = values["skills-dir"] || "/home/workspace/Skills";
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "_candidates"]);

interface SkillEntry {
  slug: string;
  has_governance_md: boolean;
  has_skill_md: boolean;
  governance_path?: string;
}

function isSkillDir(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, "SKILL.md"));
}

function scan(dir: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const hasSkill = isSkillDir(full);
    if (!hasSkill) continue; // not a skill dir
    const govPath = path.join(full, "GOVERNANCE.md");
    const hasGov = fs.existsSync(govPath);
    out.push({
      slug: entry.name,
      has_skill_md: true,
      has_governance_md: hasGov,
      governance_path: hasGov ? govPath : undefined,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function main() {
  const skills = scan(SKILLS_DIR);
  const withGov = skills.filter((s) => s.has_governance_md).length;
  const ratio = skills.length === 0 ? 0 : withGov / skills.length;
  const report = {
    generated_at: new Date().toISOString(),
    skills_dir: SKILLS_DIR,
    skills,
    rollup: {
      total: skills.length,
      with_governance: withGov,
      ratio,
      ratio_pct: Math.round(ratio * 1000) / 10,
    },
  };

  if (values.pretty) {
    console.log(`\nCapability-Ethics Ratio — ${SKILLS_DIR}`);
    console.log(`Generated ${report.generated_at}\n`);
    console.log(`Total skills:            ${report.rollup.total}`);
    console.log(`With GOVERNANCE.md:      ${report.rollup.with_governance}`);
    console.log(`Ratio:                   ${report.rollup.ratio_pct}%\n`);
    console.log("Per-skill:");
    for (const s of skills) {
      const icon = s.has_governance_md ? "✅" : "  ";
      console.log(`  ${icon} ${s.slug}`);
    }
    console.log();
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

if (import.meta.main) main();
