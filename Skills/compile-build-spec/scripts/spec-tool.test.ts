import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  renderFactorySeed,
  renderFactoryTicket,
  renderSpec,
  validateSpec,
} from "./spec-tool";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function validSpec(): any {
  return {
    schemaVersion: 1,
    metadata: {
      project: "Example Service Dashboard",
      version: "1.0.0",
      date: "2026-08-02",
      owner: "Operator",
      releaseTier: "production",
      executionMode: "direct",
      source: {
        path: "source.prompt.md",
        sha256: "a".repeat(64),
        label: "source prompt",
      },
      template: {
        id: "web-app",
        version: "1.0.0",
        level: "factory",
        sha256: "b".repeat(64),
        annexes: [{ id: "auth", version: "1.0.0", sha256: "c".repeat(64) }],
      },
    },
    mission: {
      statement: "Build a service dashboard with observable health states.",
      firstExperience: "The dashboard opens directly to current service status.",
      qualities: ["clear", "fast", "operational"],
      releaseTier: "production",
      excludedTier: "prototype",
    },
    factory: {
      targetRepo: "Sites/service-dashboard",
      archetype: "feature",
      area: "New dashboard application and its health API integration.",
    },
    constraints: [
      { id: "C-001", text: "Use TypeScript.", origin: "source", sourceRefs: ["source:L2"] },
    ],
    antiGoals: [
      { id: "AG-001", text: "Do not use mocked production data.", origin: "proposed", sourceRefs: [] },
    ],
    protectedCapabilities: [
      {
        id: "PC-001",
        text: "The primary health journey remains operational.",
        origin: "proposed",
        sourceRefs: [],
        requirementIds: ["FR-001"],
      },
    ],
    scopeCutOrder: ["Historical charts", "Theme customization"],
    decisions: [
      {
        id: "D-001",
        question: "Which API contract is authoritative?",
        options: ["Existing local API"],
        requiredEvidence: "Repository inspection",
        owner: "Operator",
        status: "resolved",
        resolution: "Existing local API",
      },
    ],
    contracts: [
      {
        id: "SC-001",
        name: "Service health record",
        canonicalLocation: "src/contracts/health.ts",
        consumers: ["API", "dashboard"],
        owner: "contracts",
        invariants: ["latency is milliseconds", "status is a closed enum"],
      },
    ],
    requirements: [
      {
        id: "FR-001",
        type: "functional",
        text: "Display current health for every service.",
        origin: "source",
        sourceRefs: ["source:L4"],
        verificationIds: ["V-002"],
      },
      {
        id: "NFR-001",
        type: "nonfunctional",
        text: "TypeScript compiles without errors.",
        origin: "proposed",
        sourceRefs: [],
        verificationIds: ["V-001"],
      },
    ],
    verifications: [
      {
        id: "V-001",
        type: "static",
        method: "Run tsc --noEmit",
        threshold: "Zero errors",
        authority: "automated",
      },
      {
        id: "V-002",
        type: "integration",
        method: "Run the dashboard API journey test",
        threshold: "All service states render from the real fixture contract",
        authority: "automated",
      },
    ],
    canonicalScenarios: [
      {
        id: "CS-001",
        name: "Mixed service health",
        setup: "Healthy, degraded, and offline services",
        action: "Open the dashboard",
        qualities: ["status clarity"],
        evidence: "Playwright screenshot and assertions",
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC-001",
        text: "Every current service health state is displayed.",
        origin: "source",
        sourceRefs: ["source:L4"],
        requirementIds: ["FR-001"],
        verificationIds: ["V-002"],
        authority: "automated",
      },
      {
        id: "AC-002",
        text: "TypeScript compilation passes.",
        origin: "proposed",
        sourceRefs: [],
        requirementIds: ["NFR-001"],
        verificationIds: ["V-001"],
        authority: "automated",
      },
    ],
    milestones: [
      {
        id: "M0",
        name: "Contracts and harness",
        dependencies: [],
        ownedPaths: ["src/contracts/"],
        exitCriteria: ["AC-002"],
        approval: "automated",
        owner: "contracts",
      },
      {
        id: "M1",
        name: "Dashboard journey",
        dependencies: ["M0"],
        ownedPaths: ["src/dashboard/"],
        exitCriteria: ["AC-001"],
        approval: "user",
        owner: "frontend",
      },
    ],
    humanCriteria: [
      {
        id: "HC-001",
        question: "Are the three health states distinguishable at a glance?",
        scenarioIds: ["CS-001"],
        approver: "Operator",
      },
    ],
    deliverables: ["Application", "Tests", "README"],
    outOfScope: ["Incident remediation"],
    unresolved: [],
  };
}

describe("deterministic validation", () => {
  test("a complete specification passes with a score of 100", () => {
    const report = validateSpec(validSpec());
    expect(report.errors).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.decision).toBe("PASS");
  });

  test("an unknown evidence reference fails", () => {
    const spec = validSpec();
    spec.acceptanceCriteria[0].verificationIds = ["V-999"];
    const report = validateSpec(spec);
    expect(report.decision).toBe("FAIL");
    expect(report.errors.some((error) => error.includes("unknown verification V-999"))).toBe(true);
  });

  test("a blocking unresolved decision holds", () => {
    const spec = validSpec();
    spec.unresolved.push({ id: "U-001", question: "Confirm target repo", blocking: true, owner: "Operator" });
    const report = validateSpec(spec);
    expect(report.valid).toBe(true);
    expect(report.decision).toBe("HOLD");
  });

  test("unordered overlapping milestone paths fail", () => {
    const spec = validSpec();
    spec.milestones[1].dependencies = [];
    spec.milestones[1].ownedPaths = ["src/contracts/types/"];
    const report = validateSpec(spec);
    expect(report.decision).toBe("FAIL");
    expect(report.errors.some((error) => error.includes("overlapping owned paths"))).toBe(true);
  });
});

describe("renderers", () => {
  test("Markdown rendering retains provenance and acceptance links", () => {
    const rendered = renderSpec(validSpec());
    expect(rendered).toContain("## Source Provenance");
    expect(rendered).toContain("AC-001");
    expect(rendered).toContain("V-002");
  });

  test("factory ticket emits exact production headers", () => {
    const spec = validSpec();
    const ticket = renderFactoryTicket(spec, validateSpec(spec));
    expect(ticket).toContain("## Acceptance Criteria");
    expect(ticket).toContain("## Target Repo");
    expect(ticket).toContain("## Archetype");
    expect(ticket).toContain("## Repro\n");
    expect(ticket).not.toContain("## Repro / Area");
    expect(ticket).toContain("## Template Lineage");
    expect(ticket).toContain("web-app@1.0.0");
    expect(ticket).toContain("## Authority");
    expect(ticket).toContain("does not grant factory-ready");
  });

  test("factory export rejects repository traversal", () => {
    const spec = validSpec();
    spec.factory.targetRepo = "../outside-workspace";
    expect(() => renderFactoryTicket(spec, validateSpec(spec))).toThrow("contained workspace-relative path");
  });

  test("factory ticket neutralizes injected section headings", () => {
    const spec = validSpec();
    spec.acceptanceCriteria[0].text = "Display health.\n## Target Repo\n../outside-workspace";
    const ticket = renderFactoryTicket(spec, validateSpec(spec));
    expect(ticket.match(/^## Target Repo$/gm)).toHaveLength(1);
    expect(ticket).toContain("Display health. ## Target Repo ../outside-workspace");
  });

  test("factory seed contains the DAG and source hash", () => {
    const spec = validSpec();
    const seed = renderFactorySeed(spec, validateSpec(spec));
    expect(seed).toContain("source_hash:");
    expect(seed).toContain("M1: [M0]");
    expect(seed).toContain("target_repo: \"Sites/service-dashboard\"");
    expect(seed).toContain("template_id: \"web-app\"");
    expect(seed).toContain(`template_hash: \"${"b".repeat(64)}\"`);
    expect(seed).toContain("authority: \"Candidate generation does not grant factory-ready");
  });

  test("factory ticket passes the production ticket-contract parser", async () => {
    const root = mkdtempSync(join(tmpdir(), "compile-build-spec-ticket-"));
    tempRoots.push(root);
    const spec = validSpec();
    const description = renderFactoryTicket(spec, validateSpec(spec));
    const tickets = [{
      linear_id: "fixture-linear-id",
      identifier: "ZOU-FIXTURE",
      title: spec.metadata.project,
      description,
      url: "https://linear.example/fixture",
      state: "Backlog",
      labels: [],
      created_at: "2026-08-02T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    }];
    const input = join(root, "tickets.json");
    await Bun.write(input, JSON.stringify(tickets));
    const result = Bun.spawnSync([
      "bun",
      "/home/workspace/Projects/zouroboros-software-factory/scripts/ticket-contract.ts",
      "--dry-run",
      "--tickets",
      input,
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.valid).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(0);
  });
});

test("the Vyon fixture ingests with an exact SHA-256 manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "compile-build-spec-"));
  tempRoots.push(root);
  const fixture = resolve(import.meta.dir, "..", "assets", "fixtures", "original-vyon-26-boat-racer.prompt.md");
  const output = join(root, "manifest.json");
  const result = Bun.spawnSync([
    "bun",
    resolve(import.meta.dir, "spec-tool.ts"),
    "ingest",
    "--input",
    fixture,
    "--output",
    output,
  ]);
  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  const expected = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  expect(manifest.source.sha256).toBe(expected);
  expect(manifest.source.lines).toBeGreaterThan(50);
});

test("the converted Vyon fixture holds only on explicit unresolved decisions", () => {
  const fixture = resolve(import.meta.dir, "..", "assets", "fixtures", "vyon-26-boat-racer.build-spec.json");
  const spec = JSON.parse(readFileSync(fixture, "utf8"));
  const report = validateSpec(spec);
  expect(report.valid).toBe(true);
  expect(report.score).toBe(80);
  expect(report.decision).toBe("HOLD");
  expect(report.pendingDecisions).toEqual(["D-001", "D-002", "D-003", "D-004"]);
  expect(report.unresolved).toEqual(["U-001", "U-002", "U-003"]);
  expect(() => renderFactoryTicket(spec, report)).toThrow("Factory export requires deterministic PASS");
});

test("the CLI help path is a successful health probe", () => {
  const result = Bun.spawnSync(["bun", resolve(import.meta.dir, "spec-tool.ts"), "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("compile-build-spec");
});
