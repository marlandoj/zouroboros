import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyRung, unwrapMcpResult, validateChain } from "./healer";

type Config = Parameters<typeof validateChain>[0];

function configWith(fallbacks: string[], labels: Record<string, string>): Config {
  return {
    healerConfig: { model: "zo:fast", label: "Zo Fast", rule: "test" },
    probeConfig: {
      prompt: "test",
      expectedSubstring: "test",
      timeoutMs: 1,
      retries: 0,
      latencyThresholds: { degradedMs: 1, slowMs: 1 },
    },
    fallbackChains: {
      "byok:claude": { label: "Claude Code Sonnet", fallbacks },
      "byok:gpt-oss": { label: "GPT-OSS-120B", fallbacks: ["zo:smart"] },
    },
    modelLabels: labels,
  };
}

describe("model healer fallback-chain policy", () => {
  test("classifies GPT-OSS as open-weight before the generic GPT hint", () => {
    expect(classifyRung("byok:model", "GPT-OSS-120B")).toBe("open-weight");
  });

  test("accepts a proprietary chain with GPT-OSS before the Zo-native terminal", () => {
    const config = configWith(
      ["byok:gpt-oss", "zo:smart"],
      { "byok:claude": "Claude Code Sonnet", "byok:gpt-oss": "GPT-OSS-120B" },
    );

    expect(validateChain(config)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("rejects a proprietary chain without an open-weight rung", () => {
    const config = configWith(
      ["zo:smart"],
      { "byok:claude": "Claude Code Sonnet", "byok:gpt-oss": "GPT-OSS-120B" },
    );

    expect(validateChain(config).errors).toContain(
      "Proprietary chain 'Claude Code Sonnet' lacks an open-weight rung before terminal exhaustion (Q2 #6 invariant)",
    );
  });

  test("keeps the tracked fallback-chain example policy-compliant", () => {
    const example = JSON.parse(
      readFileSync(new URL("../assets/fallback-chain.example.json", import.meta.url), "utf8"),
    ) as Config;

    expect(validateChain(example)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("routes live Claude chains to a non-Claude provider first", () => {
    const live = JSON.parse(
      readFileSync(new URL("../assets/fallback-chain.json", import.meta.url), "utf8"),
    ) as Config;

    const claudeChains = Object.entries(live.fallbackChains)
      .filter(([, chain]) => /claude|sonnet|haiku|opus/i.test(chain.label));

    expect(claudeChains.length).toBeGreaterThan(0);
    for (const [, chain] of claudeChains) {
      const firstFallback = chain.fallbacks[0];
      const firstLabel = live.modelLabels[firstFallback] || firstFallback;
      expect(firstLabel).not.toMatch(/claude|sonnet|haiku|opus/i);
    }
  });

  test("rejects a healer model that appears in a monitored chain", () => {
    const config = configWith(
      ["byok:gpt-oss", "zo:smart"],
      { "byok:claude": "Claude Code Sonnet", "byok:gpt-oss": "GPT-OSS-120B" },
    );
    config.healerConfig.model = "byok:claude";

    expect(validateChain(config).errors).toContain(
      "Healer model 'byok:claude' must remain outside every monitored fallback chain",
    );
  });
});

describe("model healer MCP adapter", () => {
  test("returns text from a successful MCP tool result", () => {
    expect(unwrapMcpResult({ result: { content: [{ type: "text", text: "ok" }], isError: false } }, "test")).toBe("ok");
  });

  test("throws when an MCP tool returns isError", () => {
    expect(() => unwrapMcpResult(
      { result: { content: [{ type: "text", text: "invalid arguments" }], isError: true } },
      "edit_automation",
    )).toThrow("MCP edit_automation failed: invalid arguments");
  });
});
