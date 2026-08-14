import { describe, expect, test } from "bun:test";
import {
  hoursAgo,
  renderHtmlReport,
  type AgentRun,
  type ModelCall,
} from "./agent-observability";

const now = new Date("2026-07-24T16:00:00.000Z");

describe("agent observability HTML report", () => {
  test("computes an exact rolling window", () => {
    expect(hoursAgo(24, now)).toBe("2026-07-23T16:00:00.000Z");
  });

  test("renders metrics and escapes log-derived labels", () => {
    const calls: ModelCall[] = [
      {
        ts: "2026-07-24T15:00:00.000Z",
        workload: "<script>alert(1)</script>",
        provider: "test",
        model: "test-model",
        latency_ms: 100,
        cost_usd: 0.25,
      },
    ];
    const runs: AgentRun[] = [
      {
        ts: "2026-07-24T15:30:00.000Z",
        agent_id: "agent-1",
        agent_name: "<strong>unsafe</strong>",
        model: "test-model",
        exit_code: 1,
        duration_ms: 2000,
        cost_usd: 0.1,
      },
    ];

    const html = renderHtmlReport(calls, runs, now);

    expect(html).toContain("Rolling 24-hour fleet health report");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;strong&gt;unsafe&lt;/strong&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("100.0%");
    expect(html).toContain("$0.25");
  });

  test("renders a healthy empty report without invalid metrics", () => {
    const html = renderHtmlReport([], [], now);

    expect(html).toContain("<strong>Healthy:</strong> All clear");
    expect(html).toContain("No agent runs recorded in this window.");
    expect(html).toContain("No model calls recorded in this window.");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});
