import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  jaccard,
  collapseWhitespace,
  dedupTokensAndLines,
  structuralCompress,
  structuralEquivalence,
  reversibleCompress,
  reversibleDecompress,
  packedTokens,
  compressItem,
  aggregate,
  type CompressionResult,
} from "../scripts/compression-benchmark";
import type { CorpusItem, ContentType } from "../scripts/compression-corpus";

describe("estimateTokens", () => {
  it("uses chars/4 ceiling", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("jaccard", () => {
  it("is 1 for identical informative tokens regardless of whitespace", () => {
    expect(jaccard("foo bar baz", "foo   bar\nbaz")).toBe(1);
  });
  it("is 1 for two empty strings", () => {
    expect(jaccard("", "")).toBe(1);
  });
  it("drops to partial overlap when tokens differ", () => {
    expect(jaccard("foo bar", "foo qux")).toBeCloseTo(1 / 3, 5);
  });
});

describe("collapseWhitespace", () => {
  it("collapses runs and trims", () => {
    expect(collapseWhitespace("a   b\t\tc  ")).toBe("a b c");
  });
  it("caps blank-line runs at one", () => {
    expect(collapseWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("dedupTokensAndLines", () => {
  it("removes exact duplicate lines", () => {
    expect(dedupTokensAndLines("x\nx\ny")).toBe("x\ny");
  });
  it("removes repeated whitespace-separated tokens within a line", () => {
    expect(dedupTokensAndLines("a b a c b")).toBe("a b c");
  });
});

describe("structuralCompress", () => {
  it("minifies embedded JSON in a tool_output while preserving data", () => {
    const text = 'mcp__zo__write_file {\n  "path": "/x",\n  "n": 1\n}';
    const out = structuralCompress(text, "tool_output");
    expect(out).toBe('mcp__zo__write_file {"path":"/x","n":1}');
    // fidelity is 1.0 because the JSON parses deep-equal
    expect(structuralEquivalence(text, out, "tool_output")).toBe(1);
  });

  it("falls back to whitespace collapse on non-JSON tool args", () => {
    const text = "some_tool not json   here";
    expect(structuralCompress(text, "tool_output")).toBe("some_tool not json here");
  });

  it("dedupes episode key-dumps without losing unique tokens", () => {
    const text = "a.b a.c a.b a.c d.e";
    const out = structuralCompress(text, "episode_document");
    expect(out).toBe("a.b a.c d.e");
    expect(structuralEquivalence(text, out, "episode_document")).toBe(1);
  });
});

describe("reversibleCompress / reversibleDecompress", () => {
  it("round-trips exactly on dotted key-dumps (the core invariant)", () => {
    const text =
      "designSystem.theme.bodyFont designSystem.theme.colorMode designSystem.colorStrategy.background designSystem.colorStrategy.primaryGold";
    const packed = reversibleCompress(text);
    expect(reversibleDecompress(packed)).toBe(text);
    expect(packed.dict.length).toBeGreaterThan(0); // actually compressed something
    expect(packedTokens(packed)).toBeLessThan(estimateTokens(text));
  });

  it("round-trips exactly on a repeated-env-var bash payload", () => {
    const text =
      'ALPACA_API_KEY="$ALPACA_API_KEY" ALPACA_API_SECRET="$ALPACA_API_SECRET" ALPACA_BASE_URL="$ALPACA_BASE_URL"';
    const packed = reversibleCompress(text);
    expect(reversibleDecompress(packed)).toBe(text);
  });

  it("is a no-op (identity) when nothing repeats", () => {
    const text = "alpha beta gamma delta";
    const packed = reversibleCompress(text);
    expect(packed.dict.length).toBe(0);
    expect(reversibleDecompress(packed)).toBe(text);
  });

  it("bails safely if sentinel characters already appear in the text", () => {
    const text = "weird  content  here repeated repeated";
    const packed = reversibleCompress(text);
    expect(reversibleDecompress(packed)).toBe(text);
  });
});

describe("compressItem", () => {
  function item(contentType: ContentType, text: string): CorpusItem {
    return {
      id: `${contentType}:t`,
      contentType,
      sourceTable: "x",
      sourceId: "t",
      text,
      charLength: text.length,
      tokens: estimateTokens(text),
    };
  }

  it("never expands and always passes AC at fidelity floor", () => {
    const r = compressItem(item("episode_document", "k.a k.b k.a k.b k.c k.a"), 0.98);
    expect(r.compressedTokens).toBeLessThanOrEqual(r.originalTokens);
    expect(r.reductionPercent).toBeGreaterThanOrEqual(0);
    expect(r.semanticEquivalence).toBeGreaterThanOrEqual(0.98);
    expect(r.passedAC).toBe(true);
  });

  it("falls back to identity (0% reduction) when no strategy helps", () => {
    const r = compressItem(item("memory_fact", "x y z"), 0.98);
    expect(r.strategy).toBe("identity");
    expect(r.reductionPercent).toBe(0);
    expect(r.passedAC).toBe(true);
  });
});

describe("aggregate", () => {
  function res(contentType: ContentType, orig: number, comp: number, strat: CompressionResult["strategy"]): CompressionResult {
    return {
      id: "x",
      contentType,
      strategy: strat,
      originalTokens: orig,
      compressedTokens: comp,
      reductionPercent: ((orig - comp) / orig) * 100,
      semanticEquivalence: 1,
      latencyMs: 1,
      passedAC: true,
    };
  }

  it("computes reduction % and strategy mix over a type", () => {
    const results = [
      res("open_loop", 100, 80, "reversible"),
      res("open_loop", 100, 100, "identity"),
    ];
    const agg = aggregate(results, "open_loop");
    expect(agg.items).toBe(2);
    expect(agg.originalTokens).toBe(200);
    expect(agg.compressedTokens).toBe(180);
    expect(agg.reductionPercent).toBe(10);
    expect(agg.strategyMix.reversible).toBe(1);
    expect(agg.strategyMix.identity).toBe(1);
    expect(agg.acPassRate).toBe(1);
  });
});
