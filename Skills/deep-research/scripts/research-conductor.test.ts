import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const conductor = readFileSync(new URL("./research.ts", import.meta.url), "utf8");
const adapter = readFileSync(new URL("./research-models.ts", import.meta.url), "utf8");

describe("deep-research conductor contracts", () => {
  test("contains no direct text-generation model or chat-completion call", () => {
    expect(conductor).not.toContain("gpt-4o-mini");
    expect(conductor).not.toContain("/v1/chat/completions");
    expect(conductor).not.toContain("const LLM_MODEL");
  });

  test("uses the pinned production MoA runtime and keeps embeddings on the shared model client", () => {
    expect(adapter).toContain("callMoaModel");
    expect(adapter).toContain("resolveProductionMoaLineup");
    expect(adapter).toContain("DEFAULT_PRODUCTION_MOA_LINEUP");
    expect(adapter).toContain('import("../../zo-memory-system/scripts/model-client")');
    expect(adapter).not.toContain('workload: "research"');
  });

  test("bounds external gather and retries transient dispatch failures", () => {
    expect(conductor).toContain("runBounded(externalTasks, 4)");
    expect(conductor).toContain("new Set([429, 500, 502, 503, 504, 529])");
    expect(conductor).toContain("attempt < 3");
  });

  test("permits one repair call and blocks report assembly on non-pass", () => {
    expect(conductor.match(/await stageRepair\(/g)?.length).toBe(1);
    expect(conductor).toMatch(/fail\(\s*"quality-regate"/);
    expect(conductor).toContain('gate.status !== "passed"');
    expect(conductor).toContain("04-consensus-attempt-${draft.attempt}.json");
  });

  test("keeps TTS configurable and does not mutate the global lineup", () => {
    expect(conductor).toContain("DEEP_RESEARCH_ELEVENLABS_TTS_MODEL");
    expect(conductor).toContain("DEEP_RESEARCH_OPENAI_TTS_MODEL");
    expect(conductor).not.toMatch(/writeFileSync\([^\n]*lineup\.json/);
  });

  test("normalizes citation glyphs and prioritizes cited sources for review", () => {
    expect(conductor).toContain('replace(/【S(\\d+)】/g, "[S$1]")');
    expect(conductor).toContain("draft.claims.flatMap((claim) => claim.sourceIds)");
    expect(conductor).toContain("cached.input_sha256 === inputSha256");
    expect(conductor).toContain('log("claim-check: claim input changed; rerunning")');
  });
});
