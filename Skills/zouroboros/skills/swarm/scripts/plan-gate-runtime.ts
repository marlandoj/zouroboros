import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface OperationalPlanGateOptions {
  mode?: string;
  planPath?: string;
  receiptPath?: string;
  workspaceRoot?: string;
  ledgerPath?: string;
  audit?: boolean;
  executionMode?: "SWARM" | "FORCE_SWARM";
  auditContext?: {
    ticketId?: string;
    identifier?: string;
    executionId?: string;
  };
}

export interface OperationalPlanGateDecision {
  action: "proceed" | "hold";
  mode: string;
  wouldHold: boolean;
  reason: string;
  auditEvent: string;
  auditError?: string;
}

const repositoryModule = resolve(
  import.meta.dir,
  "../../../../../packages/swarm/src/plan-gate-preflight.ts",
);
const canonicalWorkspaceModule = resolve(
  import.meta.dir,
  "../../../../../zouroboros/packages/swarm/src/plan-gate-preflight.ts",
);

export const SHARED_PLAN_GATE_MODULE = process.env.ZOUROBOROS_PLAN_GATE_MODULE
  ?? (existsSync(canonicalWorkspaceModule) ? canonicalWorkspaceModule : repositoryModule);

function configuredMode(options: OperationalPlanGateOptions): string {
  return options.mode ?? process.env.PLAN_GATE_MODE ?? "disabled";
}

export async function runOperationalPlanGatePreflight(
  options: OperationalPlanGateOptions = {},
): Promise<OperationalPlanGateDecision> {
  const mode = configuredMode(options);
  if (!["disabled", "advisory", "shadow", "enforce"].includes(mode)) {
    return {
      action: "hold",
      mode,
      wouldHold: true,
      reason: "invalid_plan_gate_mode",
      auditEvent: "plan_gate_hold",
      auditError: `Invalid plan gate mode '${mode}'`,
    };
  }
  if (!existsSync(SHARED_PLAN_GATE_MODULE)) {
    const enforce = mode === "enforce";
    return {
      action: enforce ? "hold" : "proceed",
      mode,
      wouldHold: mode !== "disabled",
      reason: "shared_plan_gate_unavailable",
      auditEvent: enforce ? "plan_gate_hold" : "plan_gate_unavailable",
      auditError: `Shared plan gate not found: ${SHARED_PLAN_GATE_MODULE}`,
    };
  }

  try {
    const shared = await import(pathToFileURL(SHARED_PLAN_GATE_MODULE).href);
    const config = shared.loadSwarmPlanGateConfig(options);
    return shared.runSwarmPlanGatePreflight(config);
  } catch (error) {
    const enforce = mode === "enforce";
    return {
      action: enforce ? "hold" : "proceed",
      mode,
      wouldHold: mode !== "disabled",
      reason: "shared_plan_gate_failed",
      auditEvent: enforce ? "plan_gate_hold" : "plan_gate_failed",
      auditError: error instanceof Error ? error.message : String(error),
    };
  }
}
