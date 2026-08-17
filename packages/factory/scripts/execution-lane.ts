import { resolveHetznerExecutionRoute, type HetznerExecutionRoute } from "./hetzner-executor-policy";
import { shadowFactoryComputeDecision, type FactoryComputeRoutingRecord } from "./factory-compute-routing";

export type FactoryGateDecision = "DIRECT" | "SUGGEST" | "SWARM" | "FORCE_SWARM" | "ERROR";

export interface ExecutionLaneDecision {
  lane: "hetzner" | "pool" | "inline";
  hetzner_route: HetznerExecutionRoute;
  pool_route: boolean;
  compute_shadow?: FactoryComputeRoutingRecord;
}

export function executionLaneForTicket(
  ticket: { identifier?: string; title?: string; description?: string },
  decision: FactoryGateDecision,
  env: Record<string, string | undefined> = process.env,
): ExecutionLaneDecision {
  const hetznerRoute = resolveHetznerExecutionRoute(ticket, env);
  if (hetznerRoute.requested && decision !== "ERROR") {
    const lane = "hetzner" as const;
    const computeShadow = shadowFactoryComputeDecision(ticket, decision, lane, env);
    return { lane, hetzner_route: hetznerRoute, pool_route: false, ...(computeShadow ? { compute_shadow: computeShadow } : {}) };
  }
  const poolRoute =
    env.SF003_POOL === "1"
    && (decision === "DIRECT" || decision === "SUGGEST" || decision === "SWARM" || decision === "FORCE_SWARM");
  const lane = poolRoute ? "pool" : "inline";
  const computeShadow = shadowFactoryComputeDecision(ticket, decision, lane, env);
  return {
    lane,
    hetzner_route: hetznerRoute,
    pool_route: poolRoute,
    ...(computeShadow ? { compute_shadow: computeShadow } : {}),
  };
}
