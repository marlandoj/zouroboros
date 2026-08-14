import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  retrieveFederated,
  routeFederatedQuery,
  type EvidenceSignal,
  type FederatedBackend,
  type RetrievalHit,
  type RetrievalMode,
} from "../federated-retrieval.js";

interface FixtureHit extends Omit<RetrievalHit, "signal"> {}
interface CohortCase {
  id: string;
  query: string;
  expected_ids: string[];
  vector: FixtureHit[];
  graph: FixtureHit[];
}

const cohort = JSON.parse(readFileSync(new URL("./fixtures/federated-cohort.json", import.meta.url), "utf8")) as {
  version: string;
  cases: CohortCase[];
};

function fixtureBackend(testCase: CohortCase, expansion: RetrievalHit[] = []): FederatedBackend {
  const select = (signal: EvidenceSignal, source: "memory" | "code") => {
    const rows = signal === "vector" ? testCase.vector : testCase.graph;
    return rows.filter(row => row.source === source).map(row => ({ ...row, signal }));
  };
  return {
    async vectorSearch(source) { return select("vector", source); },
    async graphSearch(source) { return select("graph", source); },
    async expandOneHop(source) { return expansion.filter(hit => hit.source === source); },
  };
}

describe("deterministic federated routing", () => {
  test("routes temporal cross-source, structural, and semantic queries deterministically", () => {
    expect(routeFederatedQuery(cohort.cases[0].query).selected).toBe("federated");
    expect(routeFederatedQuery(cohort.cases[1].query).selected).toBe("graph-only");
    expect(routeFederatedQuery(cohort.cases[2].query).selected).toBe("vector-only");
    expect(routeFederatedQuery("anything", "graph-only").reason).toBe("explicit mode override");
  });
});

describe("typed evidence envelope", () => {
  test("merges signals, preserves supersession, and prefers current evidence", async () => {
    const testCase = cohort.cases[0];
    const duplicate: RetrievalHit = {
      ...testCase.vector[0], signal: "graph", source: "memory", score: 0.8, hop: 1,
    };
    const envelope = await retrieveFederated(
      { query: testCase.query, mode: "federated", limit: 10 },
      fixtureBackend(testCase, [duplicate]),
      () => new Date("2026-07-11T00:00:00.000Z"),
    );

    expect(envelope.schema).toBe("zouroboros.evidence.v1");
    expect(envelope.constraints.max_hops).toBe(1);
    expect(envelope.evidence.find(item => item.id === "mem-decision")?.signals).toEqual(["graph", "vector"]);
    expect(envelope.evidence.find(item => item.id === "code-old")?.temporal).toMatchObject({
      status: "superseded",
      superseded_by: "code-handler",
    });
    expect(envelope.evidence[0].temporal.status).toBe("current");
    expect(envelope.evidence.every(item => item.temporal.observed_at === "2026-07-11T00:00:00.000Z")).toBe(true);
  });

  test("hard-filters backend expansion beyond one hop", async () => {
    const testCase = cohort.cases[1];
    const expansion: RetrievalHit[] = [
      { id: "hop-one", source: "code", signal: "graph", title: "one", content: "one", score: 0.8, hop: 1 },
      { id: "hop-two", source: "code", signal: "graph", title: "two", content: "two", score: 0.9, hop: 2 },
    ];
    const envelope = await retrieveFederated(
      { query: testCase.query, mode: "graph-only", limit: 10 },
      fixtureBackend(testCase, expansion),
    );
    expect(envelope.evidence.map(item => item.id)).toContain("hop-one");
    expect(envelope.evidence.map(item => item.id)).not.toContain("hop-two");
    expect(Math.max(...envelope.evidence.map(item => item.hop))).toBeLessThanOrEqual(1);
  });
});

describe(`frozen retrieval cohort ${cohort.version}`, () => {
  test("federated recall dominates vector-only and graph-only on mixed evidence", async () => {
    async function recall(mode: RetrievalMode): Promise<number> {
      let found = 0;
      let expected = 0;
      for (const testCase of cohort.cases) {
        const envelope = await retrieveFederated(
          { query: testCase.query, mode, limit: 20, expand: false },
          fixtureBackend(testCase),
        );
        const ids = new Set(envelope.evidence.map(item => item.id));
        expected += testCase.expected_ids.length;
        found += testCase.expected_ids.filter(id => ids.has(id)).length;
      }
      return found / expected;
    }

    const vector = await recall("vector-only");
    const graph = await recall("graph-only");
    const federated = await recall("federated");
    expect(vector).toBe(0.5);
    expect(graph).toBe(0.5);
    expect(federated).toBe(1);
    expect(federated).toBeGreaterThan(vector);
    expect(federated).toBeGreaterThan(graph);
  });
});
