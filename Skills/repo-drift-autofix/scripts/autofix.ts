#!/usr/bin/env bun
/**
 * repo-drift-autofix — autonomous commit+push+PR for local git drift
 *
 * Usage:
 *   bun autofix.ts --repo /path/to/repo [--dry-run]
 *
 * Exits:
 *   0  — work done (or nothing to do)
 *   1  — unrecoverable error
 */

import { spawnSync } from "child_process";
import { existsSync, statSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ─── Config ────────────────────────────────────────────────────────────────
const AUDIT_LOG = "/home/.z/repo-drift-autofix.log";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const QUALITY_GATE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "release", "HEAD"]);

const SECRET_PATTERNS: RegExp[] = [
  /sk_live_[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /-----BEGIN CERTIFICATE-----/,
  /eyJ[a-zA-Z0-9+/]{40,}\.[a-zA-Z0-9+/]{10,}\.[a-zA-Z0-9+/]{10,}/, // JWT
];

// ─── Types ─────────────────────────────────────────────────────────────────
interface Cluster {
  dir: string;
  files: string[];
  matchesBranchScope: boolean;
}

interface ClusterResult {
  dir: string;
  files: string[];
  committed: boolean;
  sha?: string;
  skippedReason?: string;
}

interface AutofixResult {
  repo: string;
  branch: string;
  dryRun: boolean;
  qualityGatePassed: boolean;
  qualityGateError?: string;
  inScopeCount: number;
  outlierCount: number;
  clusters: ClusterResult[];
  outliers: { dir: string; files: string[] }[];
  nestedRepos: { path: string; dirtyFiles: number }[];
  prUrl?: string;
  prAlreadyExists?: boolean;
  error?: string;
}

// ─── Shell helpers ─────────────────────────────────────────────────────────
function run(
  cmd: string,
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  input?: string
): { ok: boolean; stdout: string; stderr: string; timedOut: boolean } {
  const r = spawnSync("bash", ["-c", cmd], {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    input,
  });
  return {
    ok: r.status === 0 && !r.error,
    stdout: (r.stdout || "").replace(/[\r\n]+$/, ""),
    stderr: (r.stderr || "").trim(),
    timedOut: r.error?.message?.includes("ETIMEDOUT") || r.signal === "SIGTERM",
  };
}

// ─── Git helpers ────────────────────────────────────────────────────────────
function getBranch(repo: string): string {
  return run("git branch --show-current", repo).stdout;
}

function getUncommittedFiles(repo: string): string[] {
  const r = run("git status --porcelain", repo);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      // XY PATH — git porcelain v1: 2-char status + space + path
      // Can't use l.slice(3) because run() trims stdout, stripping leading space of first line
      const m = l.match(/^.{2}\s(.+)$/);
      return m ? m[1].trim() : "";
    })
    .filter(Boolean);
}

// Gitlink (mode 160000) entries are nested repos. A dirty worktree inside one
// does NOT change the parent's gitlink SHA, so `git add <path>` stages nothing
// and the follow-on `git commit` exits non-zero with empty stderr. Left in the
// cluster list these fail identically on every run, forever. Route them out and
// report them so the drift is fixed inside the nested repo instead.
function getNestedRepoPaths(repo: string): string[] {
  const r = run("git ls-files -s", repo);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("160000 "))
    .map((l) => l.split("\t")[1]?.trim() ?? "")
    .filter(Boolean);
}

function countDirtyInNestedRepo(repo: string, sub: string): number {
  const r = run("git status --porcelain", `${repo}/${sub}`);
  if (!r.ok) return 0;
  return r.stdout.split("\n").filter((l) => l.trim()).length;
}

// Never guess the push target. `origin` is not universally the repo's own
// remote: /home/workspace carries origin -> marlandoj/hermes-agent (a PUBLIC
// repo that is NOT the workspace) alongside zbr -> marlandoj/zouroboros. Blind
// `git push origin` there would publish workspace content to an unrelated
// public repo; only the pre-push client-string guard has been stopping it, by
// coincidence rather than design. Resolve deterministically or refuse.
// The workspace meta-repo is LOCAL-ONLY by operator decision (2026-08-05). It
// holds client and confidential material, and autofix commits bulk WIP it has
// not reviewed. Deliberate, PR-gated factory branches still push to zbr by hand;
// autofix never does. This is an explicit rule, not a side effect of the
// ambiguity heuristic below — repairing a branch upstream must not silently
// re-open a push path here.
const LOCAL_ONLY_REPOS = new Set(["/home/workspace"]);

function resolvePushRemote(
  repo: string,
  branch: string
): { remote: string } | { error: string } {
  if (LOCAL_ONLY_REPOS.has(repo.replace(/\/+$/, ""))) {
    return {
      error:
        `'${repo}' is local-only — autofix commits stay local and are never pushed. ` +
        `Its remotes are a public repo (origin) and zouroboros (zbr); neither is an ` +
        `acceptable destination for unreviewed bulk WIP.`,
    };
  }

  const upstream = run(`git rev-parse --abbrev-ref "${branch}@{u}"`, repo);
  if (upstream.ok && upstream.stdout.includes("/")) {
    return { remote: upstream.stdout.split("/")[0]! };
  }

  const remotes = run("git remote", repo)
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (remotes.length === 1) return { remote: remotes[0]! };
  if (remotes.length === 0) return { error: "no git remote configured" };
  return {
    error:
      `ambiguous push remote — branch '${branch}' has no upstream and the repo ` +
      `has ${remotes.length} remotes (${remotes.join(", ")}). Refusing to guess; ` +
      `set an upstream with: git branch -u <remote>/${branch}`,
  };
}

function prExists(repo: string, branch: string): string | null {
  const r = run(`gh pr list --head "${branch}" --json url --jq '.[0].url'`, repo, 15_000);
  const url = r.stdout.trim();
  return url && url.startsWith("http") ? url : null;
}

function mergedPrExists(repo: string, branch: string): string | null {
  const r = run(
    `gh pr list --head "${branch}" --state merged --json url --jq '.[0].url'`,
    repo,
    15_000
  );
  const url = r.stdout.trim();
  return url && url.startsWith("http") ? url : null;
}

// ─── Clustering ─────────────────────────────────────────────────────────────
function clusterByTopDir(files: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.replace(/^"/, "").replace(/"$/, "").split("/");
    // Group at 2 levels: e.g. "packages/swarm" or "Skills/consensus-gate"
    const key =
      parts.length >= 2
        ? `${parts[0]}/${parts[1]}`
        : parts[0];
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(f);
  }
  return map;
}

function extractScopeTokens(branch: string): string[] {
  // feat/swarm-t3-refactor → ["swarm", "t3", "refactor"]
  const stripped = branch.replace(/^(?:feat|fix|chore|refactor|docs|test|ci)\//, "");
  return stripped
    .split(/[-_/]/)
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
}

function clusterInScope(clusterKey: string, scopeTokens: string[]): boolean {
  const k = clusterKey.toLowerCase();
  return scopeTokens.some((t) => k.includes(t));
}

// ─── Safety scan ────────────────────────────────────────────────────────────
function scanForProblems(files: string[], repo: string): string[] {
  const problems: string[] = [];
  for (const f of files) {
    const fullPath = `${repo}/${f}`;
    try {
      const st = statSync(fullPath);
      if (st.size > MAX_FILE_BYTES) {
        problems.push(`${f}: too large (${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB limit)`);
        continue;
      }
      if (st.isDirectory()) continue;
      const content = readFileSync(fullPath, "utf8");
      for (const pat of SECRET_PATTERNS) {
        if (pat.test(content)) {
          problems.push(`${f}: possible secret pattern (${pat.source.slice(0, 30)}...)`);
          break;
        }
      }
    } catch {
      // binary or unreadable — skip
    }
  }
  return problems;
}

// ─── Quality gate ────────────────────────────────────────────────────────────
function runQualityGate(repo: string): { passed: boolean; error?: string } {
  // Detect package manager
  const hasPnpm = existsSync(`${repo}/pnpm-workspace.yaml`) || existsSync(`${repo}/pnpm-lock.yaml`);
  const hasBun = existsSync(`${repo}/bun.lockb`);
  const pm = hasPnpm ? "pnpm" : hasBun ? "bun" : "npm";

  // TypeScript check
  const tscCmd = `${pm} tsc --noEmit 2>&1 | tail -20`;
  const tscResult = run(tscCmd, repo, QUALITY_GATE_TIMEOUT_MS);

  if (tscResult.timedOut) {
    return { passed: false, error: `tsc timed out after ${QUALITY_GATE_TIMEOUT_MS / 1000}s` };
  }
  if (!tscResult.ok) {
    const errSummary = tscResult.stdout.split("\n").slice(-5).join(" | ");
    return { passed: false, error: `tsc failed: ${errSummary}` };
  }

  return { passed: true };
}

// ─── Commit message ──────────────────────────────────────────────────────────
function buildCommitMessage(clusterKey: string, files: string[], branch: string): string {
  const parts = clusterKey.split("/");
  const scope = parts[parts.length - 1] || clusterKey;
  const listed = files
    .slice(0, 12)
    .map((f) => `  - ${f}`)
    .join("\n");
  const extra = files.length > 12 ? `\n  ... and ${files.length - 12} more` : "";
  return [
    `wip(${scope}): auto-commit ${files.length} file(s) [repo-drift-autofix]`,
    "",
    `Files:\n${listed}${extra}`,
    "",
    `Branch: ${branch}`,
    `Auto-committed by repo-drift-autofix agent`,
  ].join("\n");
}

// ─── Audit log ───────────────────────────────────────────────────────────────
function auditLog(entry: object): void {
  const logDir = dirname(AUDIT_LOG);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
  appendFileSync(AUDIT_LOG, line, "utf8");
}

// ─── Main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const repoIdx = args.indexOf("--repo");
const repo = repoIdx >= 0 ? args[repoIdx + 1] : process.cwd();

if (!repo || !existsSync(repo)) {
  console.error(JSON.stringify({ error: `Repo path not found: ${repo}` }));
  process.exit(1);
}

const result: AutofixResult = {
  repo,
  branch: "",
  dryRun,
  qualityGatePassed: false,
  inScopeCount: 0,
  outlierCount: 0,
  clusters: [],
  outliers: [],
  nestedRepos: [],
};

try {
  // 1. Branch guards
  const branch = getBranch(repo);
  result.branch = branch;

  if (!branch) {
    result.error = "Detached HEAD or no branch — skipped";
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  if (branch.startsWith("autoloop/")) {
    result.error = "autoloop/* branch — skipped per policy";
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  if (PROTECTED_BRANCHES.has(branch)) {
    result.error = `Protected branch '${branch}' — autofix never commits to protected branches`;
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  // A branch whose canonical PR already merged is "spent": piling more drift
  // onto it just accumulates orphan commits and spawns junk draft PRs on a dead
  // branch name. Skip the whole run — real continuation work is committed by a human.
  const mergedPr = mergedPrExists(repo, branch);
  if (mergedPr) {
    result.error = `Branch '${branch}' already has a merged PR (${mergedPr}) — spent branch, autofix skipped`;
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  // 2. Get uncommitted files, excluding nested-repo gitlinks (uncommittable here)
  const allFiles = getUncommittedFiles(repo);
  const nestedPaths = getNestedRepoPaths(repo);
  const files = allFiles.filter((f) => !nestedPaths.includes(f));
  result.nestedRepos = allFiles
    .filter((f) => nestedPaths.includes(f))
    .map((p) => ({ path: p, dirtyFiles: countDirtyInNestedRepo(repo, p) }));
  if (files.length === 0) {
    result.qualityGatePassed = true;
    console.log(JSON.stringify({ ...result, message: "No uncommitted files — nothing to do" }));
    process.exit(0);
  }

  // 3. Cluster + classify
  const scopeTokens = extractScopeTokens(branch);
  const clustersMap = clusterByTopDir(files);
  const inScopeClusters: Cluster[] = [];
  const outlierClusters: Cluster[] = [];

  for (const [dir, clusterFiles] of clustersMap) {
    const inScope = clusterInScope(dir, scopeTokens);
    const cluster: Cluster = { dir, files: clusterFiles, matchesBranchScope: inScope };
    if (inScope) inScopeClusters.push(cluster);
    else outlierClusters.push(cluster);
  }

  result.inScopeCount = inScopeClusters.reduce((n, c) => n + c.files.length, 0);
  result.outlierCount = outlierClusters.reduce((n, c) => n + c.files.length, 0);
  result.outliers = outlierClusters.map((c) => ({ dir: c.dir, files: c.files }));

  if (inScopeClusters.length === 0) {
    result.qualityGatePassed = true;
    result.error = "All uncommitted files are outliers (no scope match) — no auto-commit";
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  // 4. Safety scan on in-scope files
  const inScopeFiles = inScopeClusters.flatMap((c) => c.files);
  const problems = scanForProblems(inScopeFiles, repo);
  if (problems.length > 0) {
    result.error = `Safety scan blocked: ${problems.join("; ")}`;
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  // 5. Quality gate
  const gate = runQualityGate(repo);
  result.qualityGatePassed = gate.passed;
  if (!gate.passed) {
    result.qualityGateError = gate.error;
    result.error = `Quality gate failed — skipping auto-commit`;
    console.log(JSON.stringify(result));
    auditLog({ ...result, ts: new Date().toISOString() });
    process.exit(0);
  }

  // 6. Commit each in-scope cluster
  for (const cluster of inScopeClusters) {
    const clusterResult: ClusterResult = {
      dir: cluster.dir,
      files: cluster.files,
      committed: false,
    };

    if (dryRun) {
      clusterResult.skippedReason = "dry-run";
      result.clusters.push(clusterResult);
      continue;
    }

    // Add files
    const fileArgs = cluster.files.map((f) => `"${f}"`).join(" ");
    const addResult = run(`git add ${fileArgs}`, repo);
    if (!addResult.ok) {
      clusterResult.skippedReason = `git add failed: ${addResult.stderr}`;
      result.clusters.push(clusterResult);
      continue;
    }

    // `git add` can succeed while staging nothing (e.g. an unchanged gitlink).
    // Committing an empty stage fails with empty stderr, which reads as an
    // unexplained error. Detect it here and report the real reason instead.
    if (run("git diff --cached --quiet", repo).ok) {
      clusterResult.skippedReason =
        "git add staged no changes — nothing committable in this cluster";
      result.clusters.push(clusterResult);
      continue;
    }

    // Commit — pass the message via stdin (`-F -`), never interpolated into the
    // shell command, so newlines and backticks in the body can't be mangled by
    // bash (literal \n) or trigger command substitution (empty backtick fields).
    const msg = buildCommitMessage(cluster.dir, cluster.files, branch);
    const commitResult = run(
      `git commit -F - --no-verify`,
      repo,
      GIT_TIMEOUT_MS,
      msg
    );
    if (!commitResult.ok) {
      clusterResult.skippedReason = `git commit failed: ${commitResult.stderr}`;
      // Unstage if commit failed
      run(`git restore --staged ${fileArgs}`, repo);
      result.clusters.push(clusterResult);
      continue;
    }

    // Capture SHA
    const shaResult = run("git rev-parse --short HEAD", repo);
    clusterResult.committed = true;
    clusterResult.sha = shaResult.stdout;
    result.clusters.push(clusterResult);
  }

  const anyCommitted = result.clusters.some((c) => c.committed);

  // 7. Push
  if (anyCommitted && !dryRun) {
    const target = resolvePushRemote(repo, branch);
    if ("error" in target) {
      result.error = `Push skipped: ${target.error}`;
      console.log(JSON.stringify(result));
      auditLog({ ...result, ts: new Date().toISOString() });
      process.exit(0);
    }
    const pushResult = run(`git push ${target.remote} "${branch}"`, repo, 60_000);
    if (!pushResult.ok) {
      result.error = `Push failed: ${pushResult.stderr}`;
      // Note: commits are local — don't roll back, just report
      console.log(JSON.stringify(result));
      auditLog({ ...result, ts: new Date().toISOString() });
      process.exit(0);
    }
  }

  // 8. PR (create draft if one doesn't exist)
  if (anyCommitted && !dryRun) {
    const existingPrUrl = prExists(repo, branch);
    if (existingPrUrl) {
      result.prUrl = existingPrUrl;
      result.prAlreadyExists = true;
    } else {
      const committedClusters = result.clusters.filter((c) => c.committed);
      const prTitle = `wip: ${branch} — auto-committed ${result.inScopeCount} file(s) [repo-drift-autofix]`;
      const prBody = [
        "## Auto-committed by repo-drift-autofix",
        "",
        "**Branch scope:** `" + branch + "`",
        "",
        "### Committed clusters",
        ...committedClusters.map(
          (c) =>
            `**\`${c.dir}\`** (${c.files.length} files) — sha \`${c.sha}\`\n` +
            c.files.map((f) => `- \`${f}\``).join("\n")
        ),
        "",
        ...(result.outliers.length > 0
          ? [
              "### ⚠️ Outliers (need human routing — branch scope mismatch)",
              ...result.outliers.map(
                (o) =>
                  `**\`${o.dir}\`** (${o.files.length} files)\n` +
                  o.files.map((f) => `- \`${f}\``).join("\n")
              ),
            ]
          : []),
        "",
        "> This is a draft PR. Review commit messages, check outliers, then convert to ready when satisfied.",
      ].join("\n");

      // Pass the body via stdin (`--body-file -`), not shell interpolation, so
      // markdown backticks/newlines survive intact instead of being eaten by bash.
      const prCmd =
        `gh pr create --draft --title ${JSON.stringify(prTitle)} --body-file - --head ${JSON.stringify(branch)}`;
      const prResult = run(prCmd, repo, 30_000, prBody);
      if (prResult.ok) {
        result.prUrl = prResult.stdout.split("\n").find((l) => l.startsWith("http")) || prResult.stdout;
      } else {
        result.error = `PR creation failed (commits pushed): ${prResult.stderr}`;
      }
    }
  }
} catch (err) {
  result.error = String(err);
}

console.log(JSON.stringify(result, null, 2));
auditLog({ ...result, ts: new Date().toISOString() });
process.exit(0);
