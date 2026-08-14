#!/usr/bin/env bun
/**
 * pii-leak-scan.ts — personal-detail intrusion check
 *
 * Scans copy / posts / drafts under Projects/* for personal identifiers that
 * should not appear in public or vendor-facing material (handle, location,
 * personal email, first-person voice patterns).
 *
 * Wired into design-md-drift-guard's orchestrate.ts as a judgment-call source.
 * Surface only — no auto-edit, no PR. Findings appear in the weekly digest's
 * judgment-call section per project, with file path, line number, and 2 lines
 * of context.
 *
 * Config: Skills/design-md-drift-guard/config/pii.json
 *
 * Usage:
 *   bun pii-leak-scan.ts [--json] [--project <slug>]
 *
 * Exit code 0 always. Findings carry no severity beyond surfacing — the user
 * decides what's a real intrusion vs intentional first-person.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKILL_DIR = "/home/workspace/Skills/design-md-drift-guard";
const CONFIG_PATH = join(SKILL_DIR, "config", "pii.json");
const WORKSPACE = "/home/workspace";

interface Identifier {
  label: string;
  patterns: string[];
}

interface PiiConfig {
  version: number;
  identifiers: Identifier[];
  flagPaths: string[];
  allowPaths: string[];
  contextLines: number;
  maxFindingsPerProject: number;
}

export interface PiiFinding {
  project: string;
  path: string;
  line: number;
  label: string;
  match: string;
  context: string[];
}

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes("--json");
const PROJECT_FILTER = (() => {
  const i = ARGS.indexOf("--project");
  return i >= 0 ? ARGS[i + 1] : null;
})();

if (ARGS.includes("--help") || ARGS.includes("-h")) {
  console.log(`pii-leak-scan.ts [--json] [--project <slug>]`);
  process.exit(0);
}

function loadConfig(): PiiConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function pathMatches(rel: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(rel));
}

function projectOf(rel: string): string {
  const parts = rel.split("/");
  if (parts[0] === "Projects" && parts.length >= 2) return parts[1];
  return parts[0] || "unknown";
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === ".zo") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && /\.(md|mdx|html|txt)$/i.test(name)) out.push(full);
  }
  return out;
}

function scanFile(
  abs: string,
  cfg: PiiConfig,
  perProjectCounts: Map<string, number>
): PiiFinding[] {
  const rel = relative(WORKSPACE, abs);
  const project = projectOf(rel);

  if (PROJECT_FILTER && project !== PROJECT_FILTER) return [];

  if (pathMatches(rel, cfg.allowPaths)) return [];
  if (!pathMatches(rel, cfg.flagPaths)) return [];

  const cap = cfg.maxFindingsPerProject || 25;
  if ((perProjectCounts.get(project) ?? 0) >= cap) return [];

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const findings: PiiFinding[] = [];

  for (const idf of cfg.identifiers) {
    for (const pat of idf.patterns) {
      const re = new RegExp(pat, "g");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m) continue;
        const ctxStart = Math.max(0, i - cfg.contextLines);
        const ctxEnd = Math.min(lines.length, i + cfg.contextLines + 1);
        findings.push({
          project,
          path: rel,
          line: i + 1,
          label: idf.label,
          match: m[0],
          context: lines.slice(ctxStart, ctxEnd),
        });
        const next = (perProjectCounts.get(project) ?? 0) + 1;
        perProjectCounts.set(project, next);
        if (next >= cap) return findings;
      }
    }
  }

  return findings;
}

export function runPiiScan(): {
  findings: PiiFinding[];
  scannedFiles: number;
  configMissing: boolean;
} {
  const cfg = loadConfig();
  if (!cfg) return { findings: [], scannedFiles: 0, configMissing: true };

  const projectsRoot = join(WORKSPACE, "Projects");
  const candidateFiles = walk(projectsRoot);
  const all: PiiFinding[] = [];
  const perProjectCounts = new Map<string, number>();

  for (const f of candidateFiles) {
    all.push(...scanFile(f, cfg, perProjectCounts));
  }

  return { findings: all, scannedFiles: candidateFiles.length, configMissing: false };
}

export function findingsByProject(findings: PiiFinding[]): Map<string, PiiFinding[]> {
  const out = new Map<string, PiiFinding[]>();
  for (const f of findings) {
    const arr = out.get(f.project) ?? [];
    arr.push(f);
    out.set(f.project, arr);
  }
  return out;
}

function main() {
  const result = runPiiScan();
  if (result.configMissing) {
    console.error(`[pii-leak-scan] config missing at ${CONFIG_PATH}`);
    process.exit(0);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `pii-leak-scan: ${result.findings.length} finding(s) across ${result.scannedFiles} file(s).`
  );
  if (result.findings.length === 0) return;

  const byProj = findingsByProject(result.findings);
  for (const [proj, items] of byProj) {
    console.log(`\n[${proj}] ${items.length} finding(s):`);
    for (const f of items.slice(0, 10)) {
      console.log(
        `  - ${f.path}:${f.line} (${f.label}) "${f.match}"`
      );
    }
    if (items.length > 10) console.log(`  … ${items.length - 10} more`);
  }
}

if (import.meta.main) main();
