import { describe, expect, test } from "bun:test";
import { executionLaneForTicket } from "./execution-lane";

const ENV = { SF003_POOL: "1", SF_HETZNER_EXECUTOR: "1" };

describe("factory execution lane", () => {
  test("binding Hetzner intent wins before SF-003 pool fan-out", () => {
    const lane = executionLaneForTicket(
      { title: "Build", description: "Hetzner is to be used for the complete execution." },
      "SWARM",
      ENV,
    );
    expect(lane.lane).toBe("hetzner");
    expect(lane.pool_route).toBe(false);
    expect(lane.hetzner_route.binding).toBe(true);
  });

  test("ordinary work keeps the enabled pool lane", () => {
    const lane = executionLaneForTicket(
      { title: "Build", description: "Implement the requested change." },
      "SWARM",
      ENV,
    );
    expect(lane.lane).toBe("pool");
    expect(lane.pool_route).toBe(true);
  });

  test("negated Hetzner language does not override the pool", () => {
    const lane = executionLaneForTicket(
      { title: "Build", description: "Do not use Hetzner for this build." },
      "DIRECT",
      ENV,
    );
    expect(lane.lane).toBe("pool");
    expect(lane.hetzner_route.requested).toBe(false);
  });

  test("compute routing is absent by default and cannot change the incumbent lane", () => {
    const lane = executionLaneForTicket(
      { title: "Verify public fixture", description: "Run 10 deterministic test shards." },
      "DIRECT",
      ENV,
    );
    expect(lane.lane).toBe("pool");
    expect(lane.compute_shadow).toBeUndefined();
  });

  test("shadow routing records a Modal proposal without dispatch or lane mutation", () => {
    const lane = executionLaneForTicket(
      { title: "Verify public fixture", description: "Run deterministic public fixture test shards." },
      "DIRECT",
      {
        ...ENV,
        FACTORY_COMPUTE_ROUTER: "shadow",
        FACTORY_COMPUTE_ENVIRONMENT: "test",
        FACTORY_COMPUTE_ENVIRONMENT_ENABLED: "1",
        FACTORY_COMPUTE_MODAL: "1",
        FACTORY_COMPUTE_WORKLOADS: "deterministic-verification",
        FACTORY_COMPUTE_MODAL_MAX_USD: "1",
        FACTORY_COMPUTE_ESTIMATE_USD: "0.1",
        FACTORY_COMPUTE_APPROVAL_ID: "shadow-qualification",
      },
    );
    expect(lane.lane).toBe("pool");
    expect(lane.compute_shadow).toMatchObject({
      incumbent_lane: "pool",
      no_dispatch: true,
      proposed: { action: "shadow", provider: "modal" },
    });
  });

  test("canonical mutation language is held while incumbent execution stays unchanged", () => {
    const lane = executionLaneForTicket(
      { title: "Update Linear", description: "Commit and merge a GitHub change." },
      "DIRECT",
      {
        ...ENV,
        FACTORY_COMPUTE_ROUTER: "shadow",
        FACTORY_COMPUTE_ENVIRONMENT_ENABLED: "1",
        FACTORY_COMPUTE_LOCAL: "1",
        FACTORY_COMPUTE_WORKLOADS: "agent-session",
        FACTORY_COMPUTE_APPROVAL_ID: "shadow-qualification",
        FACTORY_COMPUTE_ESTIMATE_USD: "0",
      },
    );
    expect(lane.lane).toBe("pool");
    expect(lane.compute_shadow?.proposed).toMatchObject({ action: "hold", holdReason: "unauthorized_mutation" });
  });
});
