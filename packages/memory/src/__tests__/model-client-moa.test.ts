import { describe, test, expect } from "bun:test";
import path from "node:path";
import {
  getMoaProposers,
  localTierArmed,
  localChat,
  localInferenceHealthCheck,
  type Proposer,
} from "../standalone/model-client";

// The module reads ZO_VLLM_BASE_URL at load. These in-process tests assert the
// DEFAULT (unarmed) contract — the MoA lineup must be byte-identical to the
// pre-ZOU-421 3-vendor default when the local tier is not configured. The armed
// behavior (4th proposer) is verified in a child process below so env is set
// before the module loads.

describe("model-client MoA local tier (ZOU-421)", () => {
  test("dormant by default: 3 vendor proposers, local tier unarmed", () => {
    const ps = getMoaProposers();
    expect(ps.length).toBe(3);
    expect(ps.every((p) => p.kind === "vendor")).toBe(true);
    expect(localTierArmed()).toBe(false);
  });

  test("vendor proposer slugs unchanged (byte-identical default lineup)", () => {
    const slugs = getMoaProposers().map((p) => p.slug);
    expect(slugs).toEqual([
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2.6",
      "deepseek/deepseek-v4-pro",
    ]);
  });

  test("localChat throws clearly when the local tier is not configured", async () => {
    const noBase: Proposer = { slug: "local/x", kind: "local", model: "x" };
    await expect(localChat(noBase, undefined, "prompt", 100, 0.2)).rejects.toThrow(
      /ZO_VLLM_BASE_URL not configured/
    );
  });

  test("localInferenceHealthCheck reports unavailable when unarmed", async () => {
    if (localTierArmed()) return; // only meaningful in the default unarmed env
    const r = await localInferenceHealthCheck();
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/ZO_VLLM_BASE_URL not set/);
  });

  test("armed lineup registers a 4th local proposer (child process, env set before load)", async () => {
    const modPath = path.resolve(import.meta.dir, "../standalone/model-client.ts");
    const script =
      `(async()=>{` +
      `const m=await import(${JSON.stringify(modPath)});` +
      `const ps=m.getMoaProposers();` +
      `console.log(JSON.stringify({n:ps.length,kinds:ps.map(p=>p.kind),slug4:ps[3]?ps[3].slug:null,armed:m.localTierArmed()}));` +
      `})();`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: {
        ...process.env,
        ZO_VLLM_BASE_URL: "http://gpu-annex:8000/v1",
        ZO_VLLM_MODEL: "qwen3-32b",
        ZO_VLLM_API_KEY: "",
      },
      cwd: import.meta.dir,
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    const parsed = JSON.parse(out) as {
      n: number;
      kinds: string[];
      slug4: string | null;
      armed: boolean;
    };
    expect(parsed.n).toBe(4);
    expect(parsed.kinds).toContain("local");
    expect(parsed.kinds.filter((k) => k === "vendor").length).toBe(3);
    expect(parsed.slug4).toBe("local/qwen3-32b");
    expect(parsed.armed).toBe(true);
  });
});
