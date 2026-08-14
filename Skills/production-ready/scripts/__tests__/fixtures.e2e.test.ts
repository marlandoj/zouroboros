import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUDIT = join(import.meta.dir, "..", "audit.ts");

interface VerdictFile {
  verdict: string;
  findingsVerdict: string;
  coverageCeiling: string;
  cappedByCoverage: boolean;
  hardBlockerIds: string[];
  coverage: { incomplete: boolean; missingScanners: string[]; gaps: Array<{ severity: string; detail: string }> };
}

/** Run the real audit binary against a repo dir; return exit code + verdict.json. */
function runAudit(repo: string, extraArgs: string[] = []): { code: number; verdict: VerdictFile } {
  const out = mkdtempSync(join(tmpdir(), "pr-out-"));
  const res = spawnSync("bun", [AUDIT, "--repo", repo, "--out", out, "--format", "json", ...extraArgs], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const verdict = JSON.parse(readFileSync(join(out, "verdict.json"), "utf8")) as VerdictFile;
  rmSync(out, { recursive: true, force: true });
  return { code: res.status ?? -1, verdict };
}

let cleanDir: string;
let vulnDir: string;
const dirs: string[] = [];

beforeAll(() => {
  // ── Clean app: no security issues, no vulnerable patterns ──
  cleanDir = mkdtempSync(join(tmpdir(), "pr-clean-"));
  dirs.push(cleanDir);
  writeFileSync(join(cleanDir, "package.json"), JSON.stringify({ name: "clean-app", dependencies: { next: "14.0.0" } }, null, 2));
  mkdirSync(join(cleanDir, "src"), { recursive: true });
  writeFileSync(
    join(cleanDir, "src", "page.tsx"),
    `export default function Page() {\n  return <main><h1>Hello</h1></main>;\n}\n`,
  );
  writeFileSync(join(cleanDir, "privacy.md"), "# Privacy\n\nThis fixture stores no personal data.\n");
  writeFileSync(join(cleanDir, "terms.md"), "# Terms\n\nThis fixture is for automated testing.\n");

  // ── Vulnerable app: an in-process critical (no external scanner needed) ──
  vulnDir = mkdtempSync(join(tmpdir(), "pr-vuln-"));
  dirs.push(vulnDir);
  writeFileSync(join(vulnDir, "package.json"), JSON.stringify({ name: "vuln-app" }, null, 2));
  writeFileSync(
    join(vulnDir, "access.py"),
    [
      "def check_access(user):",
      "    if False:  # bypass admin auth check for now",
      "        return require_admin(user)",
      "    return True",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("E2E: clean app", () => {
  test("REGRESSION: a clean app with no --url / no --manual-verified is NEVER launch-ready", () => {
    const { code, verdict } = runAudit(cleanDir);
    expect(verdict.verdict).not.toBe("launch-ready");
    expect(verdict.coverage.incomplete).toBe(true);
    expect(code).not.toBe(0);
    // External scanner availability can add findings, but incomplete coverage
    // must always prevent a launch-ready ceiling.
    expect(verdict.coverageCeiling).not.toBe("launch-ready");
  });
});

describe("E2E: vulnerable app", () => {
  test("`if False:` around an auth check → do-not-launch with a hard blocker", () => {
    const { code, verdict } = runAudit(vulnDir);
    expect(verdict.verdict).toBe("do-not-launch");
    expect(code).toBe(3);
    expect(verdict.hardBlockerIds.length).toBeGreaterThan(0);
    expect(verdict.hardBlockerIds.some((id) => id.includes("if-false-security"))).toBe(true);
  });

  test("hard blocker dominates even a lenient startup-mvp profile", () => {
    // Write a policy that would otherwise relax coverage; a hard blocker still wins.
    const policyPath = join(vulnDir, "audit.config.json");
    writeFileSync(policyPath, JSON.stringify({ riskProfile: "startup-mvp" }));
    const { verdict } = runAudit(vulnDir, ["--config", policyPath]);
    expect(verdict.verdict).toBe("do-not-launch");
  });
});
