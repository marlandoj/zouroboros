import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFactoryReviewGate } from "./factory-review-gate";
import type { ExecutionPolicy } from "./model-policy";
import { enqueueDirect, loadCampaigns, loadQueue } from "./pool-queue";
import { buildWorkerPrompt, dispatchWorker, loadAssignments, mockComplete, readResult, reviewWorkerImplementation } from "./pool-worker";
import type { PersonaOrchestrationRecord } from "./persona-orchestrator";

const reasoning: ExecutionPolicy = {
  tier: "Reasoning",
  pin_proposers: ["oc:a", "hf:b", "openrouter:c"],
  pin_aggregator: "hf:agg",
  model_chain: ["byok:first"],
  review_level: "consensus",
};

function input(stateDir: string, policy: ExecutionPolicy | null = reasoning) {
  return {
    execution_id: "exec-review-1",
    identifier: "ZOU-599",
    implementation_summary: "implemented scoped policy handoff",
    ticket_context: "acceptance criteria",
    workdir: "/home/workspace/Projects/zouroboros-software-factory",
    policy,
    risk_tier: "medium",
    state_dir: stateDir,
  };
}

describe("factory review gate", () => {
  test("specialist implement paths narrow the worker prompt boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-prompt-"));
    const prior = process.env.SF003_POOL_STATE_DIR;
    process.env.SF003_POOL_STATE_DIR = dir;
    try {
      enqueueDirect({
        campaign_id: "campaign-persona-prompt",
        ticket_id: "ticket-persona-prompt",
        identifier: "ZOU-1282",
        name: "persona prompt",
        description: "verify specialist boundary",
      });
      const campaign = loadCampaigns()["campaign-persona-prompt"];
      const item = loadQueue()[0];
      const assignment = {
        assignment_id: "asg-persona-prompt",
        campaign_id: campaign.campaign_id,
        task_id: item.task_id,
        model: "byok:test",
        attempt: 0,
        started_at: "2026-08-10T00:00:00.000Z",
        heartbeat_path: join(dir, "heartbeat"),
        result_path: join(dir, "result.json"),
        timeout_min: 30,
        completed_at: null,
        outcome: null,
        mock: true,
        execution_policy: null,
      };
      const prompt = buildWorkerPrompt(campaign, item, assignment, {
        shadow_phase: "dry-run",
        persona_implement_owned_paths: ["src/render/shader.ts"],
      });
      expect(prompt).toContain("Specialist implementation boundary");
      expect(prompt).toContain("- src/render/shader.ts");
      expect(prompt).toContain("broader task-owned file list does not expand");
    } finally {
      if (prior === undefined) delete process.env.SF003_POOL_STATE_DIR;
      else process.env.SF003_POOL_STATE_DIR = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("required persona critics run after deterministic review and substantiate only a passing gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    const order: string[] = [];
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "enforce",
        deterministic: () => { order.push("deterministic"); return { pass: true, summary: "clean" }; },
        persona_review: async (deterministic) => {
          order.push(`persona:${deterministic.pass}`);
          return {
            mode: "enforce",
            pass: true,
            required_count: 1,
            invoked_count: 1,
            reviews: [],
            summary: "required critic passed",
            new_cost_usd: 0.01,
          };
        },
      });
      expect(order).toEqual(["deterministic", "persona:true"]);
      expect(result.pass).toBe(true);
      expect(result.substantiated).toBe(true);
      expect(result.advance_to_verified).toBe(true);
      expect(result.persona_reviews?.required_count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or failing required persona review blocks enforce", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
        persona_review: async () => ({
          mode: "enforce",
          pass: false,
          required_count: 1,
          invoked_count: 0,
          reviews: [],
          summary: "required critic missing",
          new_cost_usd: 0,
        }),
      });
      expect(result.pass).toBe(false);
      expect(result.blocking).toBe(true);
      expect(result.advance_to_verified).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow persona evidence never changes deterministic authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
        persona_review: async () => ({
          mode: "shadow",
          pass: false,
          required_count: 1,
          invoked_count: 0,
          reviews: [],
          summary: "would invoke",
          new_cost_usd: 0,
        }),
      });
      expect(result.pass).toBe(true);
      expect(result.blocking).toBe(false);
      expect(result.advance_to_verified).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs deterministic checks for Routine work without paying for a second consensus panel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let consensusCalls = 0;
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        prior_verification: { kind: "consensus", status: "passed", reference: "cg-pipeline" },
      }, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => { consensusCalls++; return { pass: true, summary: "unused", consensus_id: "x", confidence: 1 }; },
      });
      expect(result.review_level).toBe("deterministic");
      expect(result.substantiated).toBe(true);
      expect(result.substantiation).toContain("cg-pipeline");
      expect(result.advance_to_verified).toBe(true);
      expect(consensusCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforce will not promote a clean diff that nothing substantive reviewed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => ({ pass: true, summary: "unused", consensus_id: "x", confidence: 1 }),
      });
      // The work is not rejected — it simply is not promoted on a whitespace
      // check alone. This is the SF_FACTORY_CONSENSUS=0 hole failing closed.
      expect(result.pass).toBe(true);
      expect(result.blocking).toBe(false);
      expect(result.substantiated).toBe(false);
      expect(result.advance_to_verified).toBe(false);
      expect(result.substantiation).toContain("deterministic check alone cannot promote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent or failed prior consensus does not substantiate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      for (const status of ["absent", "needs-review", "failed"]) {
        const result = await runFactoryReviewGate({
          ...input(dir, null),
          prior_verification: { kind: "consensus", status, reference: null },
        }, {
          mode: "enforce",
          deterministic: () => ({ pass: true, summary: "clean" }),
        });
        expect(result.substantiated).toBe(false);
        expect(result.advance_to_verified).toBe(false);
        expect(result.substantiation).toContain(status);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an operator approval substantiates a deterministic recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        prior_verification: { kind: "operator", status: "passed", reference: "marlandoj" },
      }, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
      });
      expect(result.substantiated).toBe(true);
      expect(result.substantiation).toContain("operator approval by marlandoj");
      expect(result.advance_to_verified).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow never promotes even when fully substantiated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        prior_verification: { kind: "consensus", status: "passed", reference: "cg-1" },
      }, {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
      });
      expect(result.substantiated).toBe(true);
      expect(result.advance_to_verified).toBe(false);
      expect(result.blocking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Reasoning work uses consensus only with operator authorization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir), {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        model_review_authorized: true,
        consensus: async () => ({ pass: false, summary: "rejected", consensus_id: "cg-1", confidence: 0.9 }),
      });
      expect(result.pass).toBe(false);
      expect(result.blocking).toBe(true);
      expect(result.advance_to_verified).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, "review-exec-review-1.json"), "utf8")).consensus.consensus_id).toBe("cg-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow records the same rejection without advancing or blocking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir), {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
        model_review_authorized: true,
        consensus: async () => ({ pass: false, summary: "unavailable", consensus_id: null, confidence: null }),
      });
      expect(result.pass).toBe(false);
      expect(result.blocking).toBe(false);
      expect(result.advance_to_verified).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("high risk requires consensus when the operator authorizes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let calls = 0;
      const high = { ...input(dir, null), risk_tier: "high" };
      const result = await runFactoryReviewGate(high, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        model_review_authorized: true,
        consensus: async () => { calls++; return { pass: true, summary: "passed", consensus_id: "cg-2", confidence: 0.95 }; },
      });
      expect(calls).toBe(1);
      expect(result.advance_to_verified).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("high risk does not spend a model review without operator authorization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let calls = 0;
      const high = { ...input(dir, null), risk_tier: "high" };
      const result = await runFactoryReviewGate(high, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => { calls++; return { pass: true, summary: "passed", consensus_id: "cg-unexpected", confidence: 0.95 }; },
      });
      expect(calls).toBe(0);
      expect(result.review_level).toBe("deterministic");
      expect(result.advance_to_verified).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serialized pool policy selects the worker chain and reaches the same review resolver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-pool-"));
    const prior = process.env.SF003_POOL_STATE_DIR;
    process.env.SF003_POOL_STATE_DIR = dir;
    try {
      enqueueDirect({
        campaign_id: "campaign-policy",
        ticket_id: "ticket-1",
        identifier: "ZOU-599",
        name: "policy parity",
        description: "verify pool policy",
        execution_policy: reasoning,
        risk_tier: "high",
      });
      const campaign = loadCampaigns()["campaign-policy"];
      const item = loadQueue()[0];
      const assignment = await dispatchWorker(campaign, item, { mock: true });
      expect(assignment.model).toBe("byok:first");
      expect(assignment.execution_policy).toEqual(reasoning);
      const personaRecord: PersonaOrchestrationRecord = {
        version: 1,
        campaign_id: "campaign-policy",
        task_id: item.task_id,
        mode: "shadow",
        association: {
          template_reference: "game@1.0.0",
          version: "1.0.0",
          sha256: "a".repeat(64),
          content_fingerprint: "b".repeat(64),
        },
        directory: { snapshot_hash: "c".repeat(64), captured_at: "2026-08-10T00:00:00.000Z" },
        invocations: [],
        omitted_roles: [],
        blocked_reason: null,
        total_cost_usd: 0,
        created_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
      };
      assignment.persona_orchestration = personaRecord;
      mockComplete(assignment, "success", "pool implementation complete");
      const review = await reviewWorkerImplementation(
        campaign,
        item,
        assignment,
        { shadow_phase: "dry-run", ticket_description: "policy ticket" },
        {
          mode: "enforce",
          deterministic: () => ({ pass: true, summary: "clean" }),
          model_review_authorized: true,
          consensus: async () => ({ pass: true, summary: "passed", consensus_id: "cg-pool", confidence: 0.97 }),
        },
      );
      expect(review?.advance_to_verified).toBe(true);
      expect(loadAssignments()[0].review?.consensus?.consensus_id).toBe("cg-pool");
      expect(readResult(assignment)?.persona_orchestration).toEqual(personaRecord);
    } finally {
      if (prior === undefined) delete process.env.SF003_POOL_STATE_DIR;
      else process.env.SF003_POOL_STATE_DIR = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
