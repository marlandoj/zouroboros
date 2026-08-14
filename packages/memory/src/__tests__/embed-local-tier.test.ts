import { describe, test, expect } from "bun:test";
import path from "node:path";
import {
  embeddings,
  localEmbedTierArmed,
  localEmbedConfig,
  localEmbedHealthCheck,
} from "../standalone/model-client";

// The module reads ZO_EMBED_BASE_URL at load. These in-process tests assert the
// DEFAULT (unarmed) contract — embeddings() must be byte-identical to the
// pre-ZOU-420 OpenAI text-embedding-3-small path when the local tier is not
// configured. The armed behavior (short-circuit to localEmbeddings) is verified
// in a child process below so env is set before the module loads.

describe("model-client local embedding tier (ZOU-420)", () => {
  test("dormant by default: local tier unarmed", () => {
    expect(localEmbedTierArmed()).toBe(false);
    const cfg = localEmbedConfig();
    expect(cfg.armed).toBe(false);
    expect(cfg.baseURL).toBe("");
    expect(cfg.model).toBe("bge-m3");
    expect(cfg.dim).toBe(1024);
  });

  test("dormant default dispatches to OpenAI, not the local socket (child process, key unset)", async () => {
    // When unarmed, embeddings() must reach the OpenAI path. Run in a child
    // process with OPENAI_API_KEY unset so the OpenAI path throws
    // "OPENAI_API_KEY not set" — proving the local socket was NOT taken (which
    // would throw "[local/...] ..."). The host env may carry a live key, so we
    // cannot rely on the in-process env being keyless.
    if (localEmbedTierArmed()) return; // skip in armed env
    const modPath = path.resolve(import.meta.dir, "../standalone/model-client.ts");
    const script =
      `(async()=>{` +
      `const m=await import(${JSON.stringify(modPath)});` +
      `let threw=false, msg="";` +
      `try{ await m.embeddings("hello"); }catch(e){ threw=true; msg=e instanceof Error?e.message:String(e); }` +
      `console.log(JSON.stringify({threw,msg:msg.slice(0,80)}));` +
      `})();`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, OPENAI_API_KEY: "", ZO_OPENAI_API_KEY: "", ZO_EMBED_BASE_URL: "" },
      cwd: import.meta.dir,
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    const parsed = JSON.parse(out) as { threw: boolean; msg: string };
    expect(parsed.threw).toBe(true);
    // Must reach the OpenAI path (throws "OPENAI_API_KEY not set"), NOT the local
    // socket (which would throw "[local/...] ...").
    expect(parsed.msg).toMatch(/OPENAI_API_KEY not set/);
    expect(parsed.msg).not.toMatch(/\[local\//);
  });

  test("localEmbedHealthCheck reports unavailable when unarmed", async () => {
    if (localEmbedTierArmed()) return;
    const r = await localEmbedHealthCheck();
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/ZO_EMBED_BASE_URL not set/);
  });

  test("armed short-circuit: embeddings() routes to the local socket (child process, env set before load)", async () => {
    const modPath = path.resolve(import.meta.dir, "../standalone/model-client.ts");
    // With ZO_EMBED_BASE_URL set to an unreachable port, embeddings() must
    // short-circuit to localEmbeddings() and throw a "[local/...]" error — NOT
    // reach OpenAI (which would throw "OPENAI_API_KEY not set" or "[openai]").
    const script =
      `(async()=>{` +
      `const m=await import(${JSON.stringify(modPath)});` +
      `let armed=false, threw=false, msg="";` +
      `armed=m.localEmbedTierArmed();` +
      `try{ await m.embeddings("hi"); }catch(e){ threw=true; msg=e instanceof Error?e.message:String(e); }` +
      `console.log(JSON.stringify({armed,threw,msg:msg.slice(0,80)}));` +
      `})();`;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: {
        ...process.env,
        ZO_EMBED_BASE_URL: "http://127.0.0.1:1",
        ZO_EMBED_MODEL: "bge-m3-test",
        // Ensure the OpenAI path is NOT taken: unset the key so a leak would
        // surface as "OPENAI_API_KEY not set" rather than a silent success.
        OPENAI_API_KEY: "",
        ZO_OPENAI_API_KEY: "",
      },
      cwd: import.meta.dir,
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    const parsed = JSON.parse(out) as { armed: boolean; threw: boolean; msg: string };
    expect(parsed.armed).toBe(true);
    expect(parsed.threw).toBe(true);
    // Must be a local-socket error, NOT an OpenAI-path error.
    expect(parsed.msg).toMatch(/\[local\/bge-m3-test\]/);
    expect(parsed.msg).not.toMatch(/OPENAI_API_KEY not set/);
  });

  test("recall harness --dry-run exits 0 and covers all 12 queries", async () => {
    const script = path.resolve(import.meta.dir, "../standalone/embed-local-recall.ts");
    const outDir = path.resolve(import.meta.dir, "../standalone");
    const proc = Bun.spawn(
      ["bun", script, "--dry-run", "--out", outDir],
      { env: process.env, cwd: import.meta.dir },
    );
    const code = await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();
    expect(code).toBe(0);
    expect(stdout).toMatch(/mode=dry queries=12/);
    // All 12 queries should produce a verdict line.
    const verdictLines = stdout.split("\n").filter((l) => /→ (LOCAL_WINS|BASELINE_WINS|TIE|ERROR)/.test(l));
    expect(verdictLines.length).toBe(12);
  });

  test("reindex --dry-run exits 0 and proves the pipeline with zero Qdrant mutation", async () => {
    const script = path.resolve(import.meta.dir, "../standalone/embed-reindex.ts");
    const proc = Bun.spawn(["bun", script, "--dry-run"], { env: process.env, cwd: import.meta.dir });
    const code = await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();
    expect(code).toBe(0);
    expect(stdout).toMatch(/mode=dry/);
    expect(stdout).toMatch(/ZERO Qdrant mutation/);
    expect(stdout).toMatch(/create → embed-batch → upsert → count/);
  });
});
