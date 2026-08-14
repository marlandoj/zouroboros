import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateConstitution, verifyCanonicalDocuments, type ConstitutionInput } from "./constitution-gate";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "constitution-gate-"));
  const canonicalRoot = join(root, "zouroboros");
  const mirrorRoot = join(root, "workspace");
  mkdirSync(canonicalRoot);
  mkdirSync(mirrorRoot);
  writeFileSync(join(canonicalRoot, "ZOUROBOROS.md"), "# Zouroboros\n\nA self-evolving AI operating system.\n");
  writeFileSync(
    join(canonicalRoot, "CONSTITUTION.md"),
    Array.from({ length: 10 }, (_, index) => `## Article ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][index]} — Test\n`).join("\n"),
  );
  for (const name of ["ZOUROBOROS.md", "CONSTITUTION.md"]) {
    symlinkSync(join(canonicalRoot, name), join(mirrorRoot, name));
  }
  roots.push(root);
  return { canonicalRoot, mirrorRoot };
}

function validInput(): ConstitutionInput {
  return {
    operation: "evolve-routing-policy",
    description: "Replace a local routing rule after evaluation",
    targetFiles: ["packages/selfheal/src/router.ts"],
    modifiesModelWeights: false,
    reversible: true,
    rollbackPlan: "Revert the candidate commit",
    blastRadius: "local",
    humanApproved: false,
    provenance: { rationale: "Lower failure rate", evidence: ["evaluations/report.json"], actor: "selfheal" },
    budgetBounded: true,
    layerIntegrity: true,
    failClosed: true,
  };
}

describe("constitution gate", () => {
  test("accepts canonical documents exposed through symlinks", () => {
    const paths = fixture();
    expect(verifyCanonicalDocuments(paths).ok).toBe(true);
  });

  test("blocks a drifted workspace copy", () => {
    const paths = fixture();
    rmSync(join(paths.mirrorRoot, "CONSTITUTION.md"));
    writeFileSync(join(paths.mirrorRoot, "CONSTITUTION.md"), "drift");
    const result = verifyCanonicalDocuments(paths);
    expect(result.ok).toBe(false);
    expect(result.violations.some((item) => item.code === "X-DOCUMENT-DRIFT")).toBe(true);
  });

  test("allows a complete preflight", () => {
    const paths = fixture();
    expect(evaluateConstitution(validInput(), "preflight", paths).decision).toBe("ALLOW");
  });

  test("blocks weight modification", () => {
    const paths = fixture();
    const input = { ...validInput(), modifiesModelWeights: true };
    const result = evaluateConstitution(input, "preflight", paths);
    expect(result.violations.some((item) => item.code === "I-FROZEN-WEIGHTS")).toBe(true);
  });

  test("blocks unauthorized shared changes", () => {
    const paths = fixture();
    const input = { ...validInput(), blastRadius: "shared" as const };
    const result = evaluateConstitution(input, "preflight", paths);
    expect(result.violations.some((item) => item.code === "V-HUMAN-AUTHORIZATION")).toBe(true);
  });

  test("blocks promotion without complete verification", () => {
    const paths = fixture();
    const result = evaluateConstitution(validInput(), "promotion", paths);
    expect(result.violations.some((item) => item.code === "II-UNVERIFIED-PROMOTION")).toBe(true);
  });

  test("allows promotion with complete verification", () => {
    const paths = fixture();
    const input = {
      ...validInput(),
      verification: { mechanical: true, heldOut: true, consensus: true, regressionFree: true },
    };
    expect(evaluateConstitution(input, "promotion", paths).decision).toBe("ALLOW");
  });

  test("blocks an unauthorized constitutional amendment", () => {
    const paths = fixture();
    const input = { ...validInput(), targetFiles: ["CONSTITUTION.md"] };
    const result = evaluateConstitution(input, "preflight", paths);
    expect(result.violations.some((item) => item.code === "X-AMENDMENT-AUTHORIZATION")).toBe(true);
  });
});
