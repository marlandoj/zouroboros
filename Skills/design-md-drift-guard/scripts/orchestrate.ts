#!/usr/bin/env bun
// DESIGN.md drift orchestrator: heal-and-PR or surface-and-email.
//
// Decision flow per project:
//   1. Run drift-guard, then auto-heal planner (no apply).
//   2. If planner found mechanical edits → spin up an isolated git worktree
//      off origin/<defBranch>, apply edits there, commit, push, open PR (gh),
//      then tear down the worktree. The user's checkout is never touched.
//   3. Surface judgment-call findings (WCAG, spec errors, ambiguous matches,
//      missing tokens, oversized rogue-hex sets) for human review.
//   4. Print a markdown digest to stdout for the agent to email; also write
//      it to reports/orchestrate-YYYY-MM-DD.md.
//
// Safety:
//   - Only opens PRs; never merges. Human reviews and merges.
//   - All git mutations happen in a throwaway worktree under /tmp; the user's
//     active branch and dirty files are untouched. Worktree is removed in a
//     finally block on every code path.
//   - Skips auto-heal if site CSS uses oklch(from var(...)) derived colors
//     (handled inside auto-heal planner).
//
// Usage:
//   bun orchestrate.ts                   # full run
//   bun orchestrate.ts --no-pr           # plan + email only, no git/PR
//   bun orchestrate.ts --no-consensus    # skip consensus gate (keeps all judgment calls)
//   bun orchestrate.ts --project <slug>

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import {
  loadGuardJson,
  planForProject,
  applyEdits,
  type Project,
  type ProjectPlan,
} from "./auto-heal";

const ARGS = new Set(process.argv.slice(2));
const NO_PR = ARGS.has("--no-pr");
const NO_CONSENSUS = ARGS.has("--no-consensus");
const projectFilter = (() => {
  const i = process.argv.indexOf("--project");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const SKILL_DIR = "/home/workspace/Skills/design-md-drift-guard";
const CONFIG = join(SKILL_DIR, "scripts", "projects.json");
const REPORTS = join(SKILL_DIR, "reports");
const CONSENSUS_GATE = "/home/workspace/Skills/consensus-gate/scripts/consensus-gate.ts";
const CONSENSUS_DB = `${process.env.HOME ?? "/root"}/.zouroboros/consensus-gate.json`;

type AnnotatedJudgment = {
  text: string;
  reasoning?: string;
};

type Outcome = {
  slug: string;
  name: string;
  edits: number;
  prUrl?: string;
  prError?: string;
  skipped?: string;
  judgmentCalls: AnnotatedJudgment[];
  suppressedByConsensus: number;
};

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function shTry(cmd: string, cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", cwd });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

function findRepoRoot(filePath: string): string | null {
  const r = spawnSync("git", ["-C", dirname(filePath), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function defaultBranch(repo: string): string {
  // origin/HEAD points to the default remote branch. Falls back to "main".
  const r = shTry(`git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null`, repo);
  if (r.ok && r.out.startsWith("origin/")) return r.out.slice("origin/".length);
  return "main";
}

function openPrForPlan(
  plan: ProjectPlan,
  date: string
): { prUrl?: string; prError?: string; skipped?: string } {
  const file = plan.edits[0].file;
  const repo = findRepoRoot(file);
  if (!repo) return { skipped: `no git repo found for ${file}` };
  const defBranch = defaultBranch(repo);

  // Refresh remote tip so we branch off the latest default.
  const fetchRes = shTry(`git -C ${JSON.stringify(repo)} fetch origin ${defBranch}`);
  if (!fetchRes.ok) return { prError: `git fetch failed: ${fetchRes.out.slice(0, 200)}` };

  // Isolated worktree: lets us commit + push without touching the user's
  // checkout (no requirement that their HEAD be on default or tree be clean).
  const branch = `drift-guard-autoheal-${date}`;
  const wt = `/tmp/drift-guard-${plan.slug}-${date}-${process.pid}`;
  // Clean any leftover worktree from a prior aborted run at the same path.
  shTry(`git -C ${JSON.stringify(repo)} worktree remove --force ${JSON.stringify(wt)}`);

  const wtAdd = shTry(
    `git -C ${JSON.stringify(repo)} worktree add -B ${branch} ${JSON.stringify(wt)} origin/${defBranch}`
  );
  if (!wtAdd.ok) return { prError: `worktree add failed: ${wtAdd.out.slice(0, 200)}` };

  try {
    // Remap each edit's absolute path from the user's checkout to the worktree.
    const relpath = file.slice(repo.length); // includes leading "/"
    const wtFile = wt + relpath;
    const tracked = shTry(`git -C ${JSON.stringify(wt)} ls-files --error-unmatch ${JSON.stringify(relpath.replace(/^\//, ""))}`);
    if (!tracked.ok) return { skipped: `target file not tracked at origin/${defBranch}` };

    const remapped = plan.edits.map((e) => ({ ...e, file: wt + e.file.slice(repo.length) }));
    try {
      applyEdits(remapped);
    } catch (e: any) {
      return { prError: `applyEdits threw: ${(e.message || String(e)).slice(0, 200)}` };
    }

    const add = shTry(`git -C ${JSON.stringify(wt)} add ${JSON.stringify(wtFile)}`);
    if (!add.ok) return { prError: `git add failed: ${add.out.slice(0, 200)}` };

    const editSummary = plan.edits
      .map((e) => `  - ${e.varName}: ${e.renderedHex} → ${e.specHex} (${e.specToken})`)
      .join("\n");
    const commitMsg =
      `chore(brand): auto-heal DESIGN.md drift\n\n` +
      `Replaced ${plan.edits.length} OKLCH approximation(s) with literal spec hex` +
      `${plan.edits.length === 1 ? "" : "es"}:\n${editSummary}\n\n` +
      `Generated by Skills/design-md-drift-guard/scripts/orchestrate.ts on ${date}.`;
    const commit = shTry(
      `git -C ${JSON.stringify(wt)} commit -F - <<'EOF'\n${commitMsg}\nEOF`
    );
    if (!commit.ok) return { prError: `git commit failed: ${commit.out.slice(0, 200)}` };

    const push = shTry(`git -C ${JSON.stringify(wt)} push -u origin ${branch}`);
    if (!push.ok) return { prError: `git push failed: ${push.out.slice(0, 200)}` };

    const prBody =
      `Automated DESIGN.md drift remediation generated by ` +
      `\`Skills/design-md-drift-guard/scripts/orchestrate.ts\` on ${date}.\n\n` +
      `## Mechanical fixes applied\n\n${editSummary}\n\n` +
      `## What this PR does\n` +
      `Each declared color in DESIGN.md whose hex was missing from the live ` +
      `site CSS — but whose corresponding OKLCH approximation was within ` +
      `RGB tolerance — has been replaced with the literal spec hex. This ` +
      `brings the rendered site into byte-exact alignment with DESIGN.md.\n\n` +
      `## Review notes\n` +
      `- These are mechanical replacements; the OKLCH→hex distance is small ` +
      `(perceptually similar) but not identical. Visual diff worth a glance.\n` +
      `- If you'd rather correct the OKLCH coordinates than swap to literal ` +
      `hex, edit this PR — the orchestrator will not re-open it after merge.\n` +
      `- Judgment-call findings (WCAG, missing slots) are NOT in this PR; ` +
      `they were emailed separately for human decision.`;
    const prTitle = `chore(brand): auto-heal DESIGN.md drift (${date})`;
    const prCreate = shTry(
      `gh pr create --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(
        prBody
      )} --base ${defBranch} --head ${branch}`,
      wt
    );
    if (!prCreate.ok) return { prError: `gh pr create failed: ${prCreate.out.slice(0, 200)}` };
    const prUrl = prCreate.out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("https://github.com/"))
      .pop();
    return { prUrl };
  } finally {
    shTry(`git -C ${JSON.stringify(repo)} worktree remove --force ${JSON.stringify(wt)}`);
  }
}

function consensusFilterJudgments(
  slug: string,
  calls: string[]
): { kept: AnnotatedJudgment[]; suppressed: number } {
  if (!calls.length || NO_CONSENSUS || !existsSync(CONSENSUS_GATE)) {
    return { kept: calls.map((text) => ({ text })), suppressed: 0 };
  }

  const kept: AnnotatedJudgment[] = [];
  let suppressed = 0;

  for (let i = 0; i < calls.length; i++) {
    const text = calls[i];
    const label = `drift-guard-${slug}-judgment-${i}`;
    // Write judgment text to a temp file to avoid shell quoting/injection issues
    const tmpFile = `/tmp/drift-guard-judgment-${slug}-${i}-${Math.random().toString(36).slice(2)}.txt`;
    try {
      writeFileSync(tmpFile, text, "utf8");
      const stdout = execSync(
        `bun ${JSON.stringify(CONSENSUS_GATE)} validate --file ${JSON.stringify(tmpFile)} --criteria "brand-compliance,wcag,design-spec" --label ${JSON.stringify(label)}`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000 }
      );

      // Parse the result ID from stdout ("ID: cg-...")
      const idLine = stdout.split("\n").find((l) => l.startsWith("ID: "));
      if (!idLine) {
        kept.push({ text });
        continue;
      }
      const id = idLine.slice(4).trim();

      // Fetch full JSON result from DB
      const db: any[] = JSON.parse(readFileSync(CONSENSUS_DB, "utf8"));
      const result = db.find((r) => r.id === id);
      if (!result) {
        kept.push({ text });
        continue;
      }

      // Unanimous pass → suppress (genuine noise)
      if (result?.consensus?.pass === true && result?.consensus?.unanimous === true) {
        suppressed++;
        continue;
      }

      // Split or rejected → keep with reasoning from dissenting verdicts
      const verdicts = Array.isArray(result.verdicts) ? (result.verdicts as any[]) : [];
      const objections = verdicts
        .filter((v) => !v.pass)
        .flatMap((v) => (Array.isArray(v.issues) ? (v.issues as string[]) : []))
        .slice(0, 3);
      const conf = typeof result.consensus?.confidence === "number"
        ? result.consensus.confidence.toFixed(2)
        : "?";
      const reasoning = objections.length
        ? objections.join("; ")
        : `consensus ${result.status ?? "unknown"} (confidence ${conf})`;

      kept.push({ text, reasoning });
    } catch {
      // Soft failure: gate error → keep call as-is, never suppress
      kept.push({ text });
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  return { kept, suppressed };
}

function renderDigest(date: string, outcomes: Outcome[]): string {
  const lines: string[] = [];
  const totalPrs = outcomes.filter((o) => o.prUrl).length;
  const totalSkips = outcomes.filter((o) => o.skipped || o.prError).length;
  const totalJudgments = outcomes.reduce((n, o) => n + o.judgmentCalls.length, 0);
  const totalEdits = outcomes.reduce((n, o) => n + o.edits, 0);

  const totalSuppressed = outcomes.reduce((n, o) => n + o.suppressedByConsensus, 0);
  const suppressedNote = totalSuppressed > 0 ? ` · ${totalSuppressed} suppressed by consensus` : "";
  const status =
    totalEdits === 0 && totalJudgments === 0
      ? "✅ clean — no drift, no action"
      : `${totalPrs} PR(s) opened · ${totalEdits} mechanical fix(es) · ${totalJudgments} judgment call(s)${suppressedNote} · ${totalSkips} skipped`;

  lines.push(`# DESIGN.md Drift Orchestrator — ${date}`, "", `**Status:** ${status}`, "");

  for (const o of outcomes) {
    lines.push(`## ${o.name} (\`${o.slug}\`)`, "");
    if (o.edits === 0 && o.judgmentCalls.length === 0) {
      lines.push(`- ✅ clean`);
    }
    if (o.edits > 0) {
      if (o.prUrl) lines.push(`- ✅ ${o.edits} mechanical fix(es) → PR: ${o.prUrl}`);
      else if (o.skipped) lines.push(`- ⏭ ${o.edits} fix(es) ready but skipped: ${o.skipped}`);
      else if (o.prError) lines.push(`- ❌ ${o.edits} fix(es) attempted, PR failed: ${o.prError}`);
    }
    if (o.suppressedByConsensus > 0) {
      lines.push(`- 🤫 ${o.suppressedByConsensus} judgment call(s) suppressed as noise by consensus gate`);
    }
    if (o.judgmentCalls.length > 0) {
      lines.push(`- ⚠ judgment calls (no auto-fix):`);
      for (const j of o.judgmentCalls) {
        lines.push(`  - ${j.text}`);
        if (j.reasoning) lines.push(`    ↳ models: ${j.reasoning}`);
      }
    }
    lines.push("");
  }
  lines.push(
    `---`,
    `Full drift report: \`${REPORTS}/drift-${date}.md\``,
    `Generated by \`Skills/design-md-drift-guard/scripts/orchestrate.ts\``
  );
  return lines.join("\n");
}

function main() {
  if (!existsSync(REPORTS)) mkdirSync(REPORTS, { recursive: true });

  const cfg: { projects: Project[] } = JSON.parse(readFileSync(CONFIG, "utf8"));
  const projects = projectFilter
    ? cfg.projects.filter((p) => p.slug === projectFilter)
    : cfg.projects;

  const guard = loadGuardJson();
  const date = guard.date;
  const results = projectFilter
    ? guard.results.filter((r) => r.slug === projectFilter)
    : guard.results;

  const outcomes: Outcome[] = [];
  for (const r of results) {
    const plan = planForProject(r, projects);
    const { kept, suppressed } = consensusFilterJudgments(plan.slug, plan.judgmentCalls);
    const outcome: Outcome = {
      slug: plan.slug,
      name: plan.name,
      edits: plan.edits.length,
      judgmentCalls: kept,
      suppressedByConsensus: suppressed,
    };
    if (plan.edits.length > 0 && !NO_PR) {
      const pr = openPrForPlan(plan, date);
      Object.assign(outcome, pr);
    } else if (plan.edits.length > 0 && NO_PR) {
      outcome.skipped = "--no-pr flag set";
    }
    outcomes.push(outcome);
  }

  const digest = renderDigest(date, outcomes);
  const digestPath = join(REPORTS, `orchestrate-${date}.md`);
  writeFileSync(digestPath, digest);
  console.log(digest);
}

main();
