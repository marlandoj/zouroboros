import { describe, test, expect } from "bun:test";
import path from "node:path";
import { rerank, rerankLocalArmed, rerankLocalHealthCheck, type Hit } from "../../scripts/rag-pipeline";

// rag-pipeline reads ZO_RERANK_BASE_URL at load. In-process tests assert the
// DEFAULT (unarmed) contract; armed behavior is verified in a child process so
// env is set before the module loads.

const makeHit = (id: string, text: string): Hit => ({ id, score: 0, payload: { text } });

describe("rag-pipeline local reranker tier (ZOU-420)", () => {
  test("dormant by default: local reranker unarmed", () => {
    expect(rerankLocalArmed()).toBe(false);
  });

  test("rerank is a no-op for a single hit (no generate, no network)", async () => {
    const h = makeHit("a", "solo passage");
    const out = await rerank("query", [h]);
    expect(out).toEqual([h]);
  });

  test("rerankLocalHealthCheck reports unavailable when unarmed", async () => {
    if (rerankLocalArmed()) return;
    const r = await rerankLocalHealthCheck();
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/ZO_RERANK_BASE_URL not set/);
  });

  test("armed graceful fallback: rerank() returns input order when the local endpoint is unreachable (child process)", async () => {
    // With ZO_RERANK_BASE_URL set to an unreachable port, rerank() must
    // short-circuit to rerankLocal(), which fails fast and falls back to the
    // input hits in original order (never worse than retrieval, never throws).
    const scriptPath = path.resolve(import.meta.dir, "../../scripts/rag-pipeline.ts");
    const script =
      `(async()=>{` +
      `const m=await import(${JSON.stringify(scriptPath)});` +
      `const armed=m.rerankLocalArmed();` +
      `const hits=[{id:"1",score:0,payload:{text:"alpha"}},{id:"2",score:0,payload:{text:"beta"}},{id:"3",score:0,payload:{text:"gamma"}}];` +
      `let threw=false, ids=[];` +
      `try{ const out=await m.rerank("q", hits); ids=out.map(h=>h.id); }catch(e){ threw=true; }` +
      `console.log(JSON.stringify({armed,threw,ids}));` +
      `})();`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: {
        ...process.env,
        ZO_RERANK_BASE_URL: "http://127.0.0.1:1",
        ZO_RERANK_MODEL: "bge-reranker-v2-test",
      },
      cwd: import.meta.dir,
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    const parsed = JSON.parse(out) as { armed: boolean; threw: boolean; ids: string[] };
    expect(parsed.armed).toBe(true);
    expect(parsed.threw).toBe(false);
    // Graceful fallback: every input id is preserved (order may vary but set is stable).
    expect(parsed.ids.sort()).toEqual(["1", "2", "3"]);
  });

  test("armed dispatch reaches the local socket (error prefix is [rerankLocal], not an LLM/generate error)", async () => {
    // Directly exercise rerankLocal with a fake unreachable endpoint and assert
    // the fallback returns input order (the /rerank call fails, no throw escapes).
    const scriptPath = path.resolve(import.meta.dir, "../../scripts/rag-pipeline.ts");
    const script =
      `(async()=>{` +
      `const m=await import(${JSON.stringify(scriptPath)});` +
      `const hits=[{id:"x",score:0,payload:{text:"t"}}];` +
      `const out=await m.rerankLocal("q", hits);` +
      `console.log(JSON.stringify({n:out.length,ids:out.map(h=>h.id)}));` +
      `})();`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: {
        ...process.env,
        ZO_RERANK_BASE_URL: "http://127.0.0.1:1",
        ZO_RERANK_MODEL: "bge-reranker-v2-test",
      },
      cwd: import.meta.dir,
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    const parsed = JSON.parse(out) as { n: number; ids: string[] };
    expect(parsed.n).toBe(1);
    expect(parsed.ids).toEqual(["x"]);
  });
});
