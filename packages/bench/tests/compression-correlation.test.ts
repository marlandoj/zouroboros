import { describe, it, expect } from "bun:test";
import { seedToCorpus, pearson } from "../scripts/compression-correlation";

describe("pearson", () => {
  it("is 1 for a perfect positive linear relation", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBe(1);
  });
  it("is -1 for a perfect negative linear relation", () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBe(-1);
  });
  it("is 0 when a series has no variance", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
  it("returns 0 on length mismatch", () => {
    expect(pearson([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("seedToCorpus", () => {
  const seed = {
    facts: [{ entity: "zouroboros", key: "version", value: "v2 released" }],
    episodes: [{ id: "ep-1", summary: "deployed to npm" }],
    procedures: [{ name: "deploy", versions: [{ version: 1, steps: [{ taskPattern: "run tsc" }, { taskPattern: "run tests" }] }] }],
    swarm_dags: [{ id: "dag-1", tasks: [{ id: "t1", task: "audit site" }] }],
  };

  it("maps every text-bearing field to a corpus item with the right content type", () => {
    const items = seedToCorpus(seed);
    const byType = (ct: string) => items.filter((i) => i.contentType === ct);
    expect(byType("memory_fact").length).toBe(1);
    expect(byType("episode_document").length).toBe(1);
    expect(byType("tool_output").length).toBe(1); // one procedure version
    expect(byType("open_loop").length).toBe(1); // one swarm task
  });

  it("joins procedure steps and counts tokens", () => {
    const proc = seedToCorpus(seed).find((i) => i.contentType === "tool_output")!;
    expect(proc.text).toBe("run tsc → run tests");
    expect(proc.tokens).toBeGreaterThan(0);
    expect(proc.sourceId).toBe("deploy@v1");
  });
});
