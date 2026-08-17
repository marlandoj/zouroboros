import { describe, expect, test } from "bun:test";
import {
  POLICY_ENV_KEYS,
  applyModelPolicy,
  modelReviewAuthorized,
  formatPolicy,
  modelChainForPolicy,
  parseModelPolicy,
  policyEnvironment,
} from "./model-policy";

const REASONING = [
  "## Model Policy (project-scoped)",
  "### Reasoning tier",
  "```bash",
  "LINEUP_PIN_PROPOSERS=\"oc:a,hf:vendor/model-b,openrouter:model/c\" \\",
  "LINEUP_PIN_AGGREGATOR=\"hf:vendor/aggregator\" \\",
  "FACTORY_MODEL_CHAIN=\"byok:first,openrouter:second\"",
  "```",
  "## Acceptance Criteria",
  "LINEUP_PIN_AGGREGATOR=SHOULD_NOT_LEAK",
].join("\n");

describe("model policy parser", () => {
  test("is section-bounded and canonicalizes a Reasoning policy", () => {
    const policy = parseModelPolicy(REASONING)!;
    expect(policy.tier).toBe("Reasoning");
    expect(policy.review_level).toBe("consensus");
    expect(policy.pin_proposers).toEqual(["oc:a", "hf:vendor/model-b", "openrouter:model/c"]);
    expect(policy.pin_aggregator).toBe("hf:vendor/aggregator");
    expect(policy.model_chain).toEqual(["byok:first", "openrouter:second"]);
  });

  test("ignores headings inside ordinary backtick and tilde fences", () => {
    for (const fence of ["```", "~~~"]) {
      const policy = parseModelPolicy([
        "## Model Policy",
        `${fence}bash`,
        "## This heading is fenced, not a section boundary",
        "LINEUP_PIN_PROPOSERS=oc:a,oc:b",
        fence,
        "## Acceptance Criteria",
        "LINEUP_PIN_PROPOSERS=SHOULD_NOT_LEAK",
      ].join("\n"))!;
      expect(policy.pin_proposers).toEqual(["oc:a", "oc:b"]);
    }
  });

  test("returns null without a policy block or whitelisted assignments", () => {
    expect(parseModelPolicy("## Acceptance\nLINEUP_PIN_PROPOSERS=a,b")).toBeNull();
    expect(parseModelPolicy("## Model Policy\nSECRET_KEY=bad")).toBeNull();
  });

  test("parses Markdown-bulleted promotion environment assignments", () => {
    const policy = parseModelPolicy([
      "## Model Policy (project-scoped)",
      "Tier: Reasoning",
      "",
      "Promotion environment:",
      "",
      "* LINEUP_PIN_PROPOSERS=byok:one,oc:two,oc:three",
      "* LINEUP_PIN_AGGREGATOR=byok:judge",
    ].join("\n"))!;
    expect(policy.pin_proposers).toEqual(["byok:one", "oc:two", "oc:three"]);
    expect(policy.pin_aggregator).toBe("byok:judge");
    expect(policy.review_level).toBe("consensus");
  });

  test("rejects shell syntax, empty values, and multiple aggregators", () => {
    expect(() => parseModelPolicy("## Model Policy\nLINEUP_PIN_PROPOSERS=oc:a;touch/tmp/x")).toThrow();
    expect(() => parseModelPolicy("## Model Policy\nFACTORY_MODEL_CHAIN=\"\"")).toThrow();
    expect(() => parseModelPolicy("## Model Policy\nLINEUP_PIN_AGGREGATOR=oc:a,oc:b")).toThrow();
  });

  test("parses and section-bounds structured role chains", () => {
    const roleChains = JSON.stringify({
      proposers: [{ primary: "hf:zai-org/GLM-5.2", fallbacks: ["oc:glm-5.2"] }],
      aggregator: { primary: "hf:MiniMaxAI/MiniMax-M3", fallbacks: ["oc:minimax-m3"] },
    });
    const policy = parseModelPolicy(`## Model Policy\nLINEUP_ROLE_CHAINS='${roleChains}'\n## Repro\nLINEUP_ROLE_CHAINS=leak`)!;
    expect(policy.role_chains).toBe(roleChains);
  });

  test("only exposes the approved environment keys", () => {
    expect(POLICY_ENV_KEYS).toEqual([
      "LINEUP_PIN_PROPOSERS",
      "LINEUP_PIN_AGGREGATOR",
      "LINEUP_ROLE_CHAINS",
      "FACTORY_MODEL_CHAIN",
    ]);
  });
});

describe("model policy scope", () => {
  test("applies and restores every touched key exactly once", () => {
    const policy = parseModelPolicy(REASONING)!;
    const env: Record<string, string | undefined> = { FACTORY_MODEL_REVIEW: "operator", LINEUP_PIN_AGGREGATOR: "prior", UNRELATED: "keep" };
    const applied = applyModelPolicy(policy, env);
    expect(env.LINEUP_PIN_AGGREGATOR).toBe("hf:vendor/aggregator");
    expect(env.FACTORY_MODEL_CHAIN).toBe("byok:first,openrouter:second");
    applied.restore();
    applied.restore();
    expect(env.LINEUP_PIN_AGGREGATOR).toBe("prior");
    expect("FACTORY_MODEL_CHAIN" in env).toBe(false);
    expect(env.UNRELATED).toBe("keep");
  });

  test("clears unspecified policy keys temporarily and rejects overlapping scopes", () => {
    const policy = parseModelPolicy("## Model Policy\nLINEUP_PIN_AGGREGATOR=oc:only")!;
    const env: Record<string, string | undefined> = {
      FACTORY_MODEL_REVIEW: "operator",
      LINEUP_PIN_PROPOSERS: "stale:proposer",
      FACTORY_MODEL_CHAIN: "stale:chain",
    };
    const applied = applyModelPolicy(policy, env);
    expect("LINEUP_PIN_PROPOSERS" in env).toBe(false);
    expect("FACTORY_MODEL_CHAIN" in env).toBe(false);
    expect(env.LINEUP_PIN_AGGREGATOR).toBe("oc:only");
    expect(() => applyModelPolicy(policy, {})).toThrow("model policy scope already active");
    applied.restore();
    expect(env.LINEUP_PIN_PROPOSERS).toBe("stale:proposer");
    expect(env.FACTORY_MODEL_CHAIN).toBe("stale:chain");
    expect("LINEUP_PIN_AGGREGATOR" in env).toBe(false);
  });

  test("keeps solver chains active while suppressing model-review pins by default", () => {
    const policy = parseModelPolicy(REASONING)!;
    const env: Record<string, string | undefined> = {
      LINEUP_PIN_PROPOSERS: "stale:proposer",
      LINEUP_PIN_AGGREGATOR: "stale:aggregator",
      LINEUP_ROLE_CHAINS: "stale:roles",
    };
    const applied = applyModelPolicy(policy, env);
    expect(applied.applied).toEqual({ FACTORY_MODEL_CHAIN: "byok:first,openrouter:second" });
    expect(env.FACTORY_MODEL_CHAIN).toBe("byok:first,openrouter:second");
    expect("LINEUP_PIN_PROPOSERS" in env).toBe(false);
    expect("LINEUP_PIN_AGGREGATOR" in env).toBe(false);
    expect("LINEUP_ROLE_CHAINS" in env).toBe(false);
    applied.restore();
    expect(env.LINEUP_PIN_PROPOSERS).toBe("stale:proposer");
  });

  test("requires the exact operator authorization value", () => {
    expect(modelReviewAuthorized({})).toBe(false);
    expect(modelReviewAuthorized({ FACTORY_MODEL_REVIEW: "off" })).toBe(false);
    expect(modelReviewAuthorized({ FACTORY_MODEL_REVIEW: "operator" })).toBe(true);
    expect(() => modelReviewAuthorized({ FACTORY_MODEL_REVIEW: "auto" })).toThrow("must be off|operator");
  });

  test("rolls back partial mutations and releases the scope after an apply error", () => {
    const policy = parseModelPolicy(REASONING)!;
    const target: Record<string, string | undefined> = {
      FACTORY_MODEL_REVIEW: "operator",
      LINEUP_PIN_PROPOSERS: "prior",
      FACTORY_MODEL_CHAIN: "later-prior",
    };
    const env = new Proxy(target, {
      set(object, key, value) {
        if (key === "LINEUP_PIN_AGGREGATOR") throw new Error("injected mutation failure");
        object[String(key)] = value;
        return true;
      },
    });
    expect(() => applyModelPolicy(policy, env)).toThrow("injected mutation failure");
    expect(target.LINEUP_PIN_PROPOSERS).toBe("prior");
    expect(target.FACTORY_MODEL_CHAIN).toBe("later-prior");
    const next = applyModelPolicy(policy, {});
    next.restore();
  });

  test("keeps a failed restore retryable without leaving the scope locked", () => {
    const policy = parseModelPolicy(REASONING)!;
    const target: Record<string, string | undefined> = { FACTORY_MODEL_REVIEW: "operator", LINEUP_PIN_PROPOSERS: "prior" };
    let failRestoreOnce = true;
    const env = new Proxy(target, {
      set(object, key, value) {
        if (key === "LINEUP_PIN_PROPOSERS" && value === "prior" && failRestoreOnce) {
          failRestoreOnce = false;
          throw new Error("injected restore failure");
        }
        object[String(key)] = value;
        return true;
      },
    });
    const applied = applyModelPolicy(policy, env);
    expect(() => applied.restore()).toThrow("injected restore failure");
    const independent = applyModelPolicy(policy, {});
    independent.restore();
    applied.restore();
    expect(target.LINEUP_PIN_PROPOSERS).toBe("prior");
    const next = applyModelPolicy(policy, {});
    next.restore();
  });

  test("throws AggregateError when multiple keys fail to restore", () => {
    const policy = parseModelPolicy(REASONING)!;
    const target: Record<string, string | undefined> = { FACTORY_MODEL_REVIEW: "operator", LINEUP_PIN_PROPOSERS: "prior", LINEUP_PIN_AGGREGATOR: "prior-agg" };
    let applyDone = false;
    const env = new Proxy(target, {
      set(object, key, value) {
        if (applyDone && (key === "LINEUP_PIN_PROPOSERS" || key === "LINEUP_PIN_AGGREGATOR")) {
          throw new Error(`injected restore failure for ${String(key)}`);
        }
        object[String(key)] = value;
        return true;
      },
    });
    const applied = applyModelPolicy(policy, env);
    applyDone = true;
    expect(() => applied.restore()).toThrow(AggregateError);
  });

  test("uses serialized model chain before the default chain", () => {
    const policy = parseModelPolicy(REASONING)!;
    expect(modelChainForPolicy(policy, ["fallback"])).toEqual(["byok:first", "openrouter:second"]);
    expect(modelChainForPolicy(null, ["fallback"])).toEqual(["fallback"]);
    expect(formatPolicy(policy)).toContain("Reasoning/operator-only/inactive");
  });
});

/** FH-01 — the exact malformed value the ZBRE run propagated across four tickets. */
const VALID_CHAINS = '{"proposers":[{"primary":"hf:zai-org/GLM-5.2"}],"aggregator":{"primary":"xai:grok-3-mini"}}';

function policyWithChains(raw: string): string {
  return ["## Model Policy (project-scoped)", `LINEUP_ROLE_CHAINS=${raw}`].join("\n");
}

describe("model policy role-chain validation (FH-01)", () => {
  test("strips markdown backticks instead of propagating them to JSON.parse", () => {
    const policy = parseModelPolicy(policyWithChains(`\`${VALID_CHAINS}\``))!;
    expect(policy.role_chains).toBe(VALID_CHAINS);
    expect(() => JSON.parse(policy.role_chains!)).not.toThrow();
  });

  test("canonicalizes the value so the consensus process never sees raw markdown", () => {
    const policy = parseModelPolicy(policyWithChains(`\`\`\`${VALID_CHAINS}\`\`\``))!;
    expect(policy.role_chains).toBe(VALID_CHAINS);
  });

  test("rejects genuinely malformed JSON at parse time, not inside the gate", () => {
    expect(() => parseModelPolicy(policyWithChains('{"proposers":[},"aggregator":1}')))
      .toThrow(/LINEUP_ROLE_CHAINS must be valid JSON/);
  });

  test("rejects a structurally valid object missing the required roles", () => {
    expect(() => parseModelPolicy(policyWithChains('{"proposers":[]}')))
      .toThrow(/non-empty proposers array/);
    expect(() => parseModelPolicy(policyWithChains('{"proposers":[{"primary":"a"}]}')))
      .toThrow(/requires an aggregator/);
    expect(() => parseModelPolicy(policyWithChains('["not","an","object"]')))
      .toThrow(/must be a JSON object/);
  });

  test("a well-formed unwrapped value is unchanged", () => {
    const policy = parseModelPolicy(policyWithChains(VALID_CHAINS))!;
    expect(policy.role_chains).toBe(VALID_CHAINS);
    expect(policyEnvironment(policy).LINEUP_ROLE_CHAINS).toBeUndefined();
    expect(policyEnvironment(policy, { modelReviewAuthorized: true }).LINEUP_ROLE_CHAINS).toBe(VALID_CHAINS);
  });
});
