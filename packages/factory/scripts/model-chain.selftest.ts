#!/usr/bin/env bun
/**
 * Self-test for the /zo/ask provider-rotation helper (model-chain.ts).
 *
 * Fully hermetic: fetch is mocked with a scripted response queue, sleep is a
 * no-op, so no network and no real delays. Covers rotation on 429, transient
 * body markers (502-wrapping-429 — the real-world case), same-provider retry vs
 * immediate rotate on hard errors, exhaustion, chain parsing, and no-op success.
 *
 * Exit 0 = all green.
 */

import {
  askWithFailover,
  DEFAULT_MODEL_CHAIN,
  deriveChain,
  formatTrail,
  isTransientBody,
  loadModelChain,
  type FetchLike,
} from "./model-chain";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

type Scripted = { status?: number; body?: string; throwErr?: string };

/** Mock fetch that returns queued responses in call order; records model_names seen. */
function mockFetch(queue: Scripted[]): { fetchImpl: FetchLike; models: string[] } {
  const models: string[] = [];
  const q = [...queue];
  const fetchImpl = (async (_url: string, init: any) => {
    try {
      models.push(JSON.parse(init.body).model_name);
    } catch {
      models.push("<unparsed>");
    }
    const next = q.shift();
    if (!next) throw new Error("mockFetch: queue exhausted");
    if (next.throwErr) throw new Error(next.throwErr);
    return new Response(next.body ?? "", { status: next.status ?? 200 });
  }) as unknown as FetchLike;
  return { fetchImpl, models };
}

const noSleep = async () => {};
const CHAIN = ["byok:synthetic-glm", "openrouter:z-ai/glm-5.2"];
const okBody = (out: string) => JSON.stringify({ output: out, conversation_id: "con_x" });

async function run() {
  // ── 1. happy path: primary 200, no rotation ──────────────────────────────────
  section("1. primary succeeds — no rotation");
  {
    const { fetchImpl, models } = mockFetch([{ status: 200, body: okBody("done") }]);
    const r = await askWithFailover({ url: "u", token: "t", input: "x", chain: CHAIN, fetchImpl, sleep: noSleep });
    check("returns primary model", r.model === CHAIN[0], r.model);
    check("output parsed", r.output === "done");
    check("conversationId parsed", r.conversationId === "con_x");
    check("single attempt in trail", r.trail.length === 1, `len=${r.trail.length}`);
    check("only primary called", models.length === 1 && models[0] === CHAIN[0]);
  }

  // ── 2. primary 429 twice → rotate to openrouter ──────────────────────────────
  section("2. primary 429 (retry then rotate) → openrouter 200");
  {
    const { fetchImpl, models } = mockFetch([
      { status: 429, body: "rate limited" },
      { status: 429, body: "rate limited" },
      { status: 200, body: okBody("recovered") },
    ]);
    const r = await askWithFailover({ url: "u", token: "t", input: "x", chain: CHAIN, fetchImpl, sleep: noSleep });
    check("rotated to openrouter", r.model === CHAIN[1], r.model);
    check("output from fallback", r.output === "recovered");
    check("trail records both attempts + success", r.trail.length === 3, `len=${r.trail.length}`);
    check("primary retried once before rotate", models[0] === CHAIN[0] && models[1] === CHAIN[0] && models[2] === CHAIN[1]);
    check("trail[0] is 429 on primary", r.trail[0].status === 429 && !r.trail[0].ok);
    check("trail[2] is ok on fallback", r.trail[2].ok && r.trail[2].model === CHAIN[1]);
  }

  // ── 3. real-world: /zo/ask 502 wrapping a provider 429 in the body ────────────
  section("3. 502 body wrapping provider 429 → treated transient, rotates");
  {
    const wrapped = JSON.stringify({ error: "The model stream was interrupted... (status_code: 429, ... You've exceeded your subscription rate limits)" });
    const { fetchImpl } = mockFetch([
      { status: 502, body: wrapped },
      { status: 502, body: wrapped },
      { status: 200, body: okBody("via openrouter") },
    ]);
    const r = await askWithFailover({ url: "u", token: "t", input: "x", chain: CHAIN, fetchImpl, sleep: noSleep });
    check("rotated despite 502 status (body says 429)", r.model === CHAIN[1] && r.output === "via openrouter");
  }

  // ── 4. network throw → retry → throw → rotate ────────────────────────────────
  section("4. network error on primary → retry → rotate to fallback");
  {
    const { fetchImpl, models } = mockFetch([
      { throwErr: "ECONNRESET" },
      { throwErr: "ECONNRESET" },
      { status: 200, body: okBody("net-recovered") },
    ]);
    const r = await askWithFailover({ url: "u", token: "t", input: "x", chain: CHAIN, fetchImpl, sleep: noSleep });
    check("recovered on fallback after throws", r.model === CHAIN[1] && r.output === "net-recovered");
    check("primary tried twice (retry) then fallback", models.length === 3);
    check("throw trail has null status", r.trail[0].status === null);
  }

  // ── 5. hard error (400) → NO same-provider retry, immediate rotate ────────────
  section("5. non-transient 400 → rotate without retrying same provider");
  {
    const { fetchImpl, models } = mockFetch([
      { status: 400, body: "bad request" },
      { status: 200, body: okBody("ok2") },
    ]);
    const r = await askWithFailover({ url: "u", token: "t", input: "x", chain: CHAIN, fetchImpl, sleep: noSleep });
    check("rotated to fallback", r.model === CHAIN[1] && r.output === "ok2");
    check("primary NOT retried (only 1 primary call)", models.filter((m) => m === CHAIN[0]).length === 1, models.join(","));
    check("trail length 2 (no retry)", r.trail.length === 2, `len=${r.trail.length}`);
  }

  section("5b. bounded callers can disable same-provider retries");
  {
    const { fetchImpl, models } = mockFetch([
      { status: 429, body: "rate limited" },
      { status: 200, body: okBody("bounded-fallback") },
    ]);
    const r = await askWithFailover({
      url: "u",
      token: "t",
      input: "x",
      chain: CHAIN,
      fetchImpl,
      sleep: noSleep,
      maxAttemptsPerModel: 1,
    });
    check("bounded caller rotates after one transient attempt", r.model === CHAIN[1]);
    check("bounded caller makes one request per visited model", models.join(",") === CHAIN.join(","), models.join(","));
  }

  // ── 6. all providers exhausted → throws with trail ───────────────────────────
  section("6. every provider 429 → throws, trail attached");
  {
    const { fetchImpl } = mockFetch([
      { status: 429, body: "rl" },
      { status: 429, body: "rl" },
      { status: 429, body: "rl" },
      { status: 429, body: "rl" },
    ]);
    let threw = false;
    let trailLen = 0;
    let msg = "";
    try {
      await askWithFailover({ url: "u", token: "t", input: "x", chain: CHAIN, fetchImpl, sleep: noSleep });
    } catch (e: any) {
      threw = true;
      trailLen = e.trail?.length ?? 0;
      msg = e.message;
    }
    check("throws when chain exhausted", threw);
    check("trail has all 4 attempts (2 models × 2)", trailLen === 4, `len=${trailLen}`);
    check("message says exhausted", msg.includes("failover exhausted"), msg);
  }

  // ── 7. isTransientBody markers ────────────────────────────────────────────────
  section("7. transient body detection");
  {
    check("detects 'exceeded your subscription'", isTransientBody("You've exceeded your subscription rate limits"));
    check("detects RESOURCE_EXHAUSTED", isTransientBody("gRPC RESOURCE_EXHAUSTED"));
    check("detects bare 429 token", isTransientBody("status_code: 429"));
    check("detects overloaded (529)", isTransientBody("Overloaded"));
    check("clean success body is not transient", !isTransientBody("here is your patch"));
  }

  // ── 8. loadModelChain parsing ─────────────────────────────────────────────────
  section("8. chain loading + override");
  {
    check("default when unset", loadModelChain({} as any).length === DEFAULT_MODEL_CHAIN.length);
    check("default first entry is synthetic byok", loadModelChain({} as any)[0].startsWith("byok:"));
    const parsed = loadModelChain({ FACTORY_MODEL_CHAIN: "a, b ,c" } as any);
    check("parses comma list + trims", parsed.length === 3 && parsed[1] === "b", parsed.join("|"));
    check("blank override falls back to default", loadModelChain({ FACTORY_MODEL_CHAIN: "  " } as any).length === DEFAULT_MODEL_CHAIN.length);
  }

  // ── 9. formatTrail ────────────────────────────────────────────────────────────
  section("9. trail formatting");
  {
    const s = formatTrail([
      { model: "byok:synthetic-glm", attempt: 1, status: 429, ok: false, detail: "rl" },
      { model: "openrouter:z-ai/glm-5.2", attempt: 1, status: 200, ok: true, detail: "ok" },
    ]);
    check("renders rotation arrow", s === "byok:synthetic-glm#1=429 → openrouter:z-ai/glm-5.2#1=ok", s);
  }

  // ── 10. deriveChain from byok-catalog ────────────────────────────────────────
  section("10. deriveChain sources the fallback tier from the live byok-catalog");
  {
    const GLM = "byok:bb3d131d-749f-423b-a285-9f9efd103926";
    const FABLE5 = "byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e";
    const SOL = "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f";
    const KIMI = "byok:463350ac-4a49-4ceb-8653-042ecffa513f";
    const HAIKU = "byok:461d8d6f-9616-4391-960e-3caea2a27829";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-derive-"));
    const catPath = path.join(tmp, "byok-catalog.json");
    const writeCatalog = (fetchedAt: string, ids: string[]) =>
      fs.writeFileSync(catPath, JSON.stringify({ fetched_at: fetchedAt, models: ids.map((id) => ({ id })) }));

    const sorted = (a: string[]) => [...a].sort().join(",");
    const ALL5 = [FABLE5, SOL, GLM, HAIKU, KIMI]; // == BYOK_CHAIN_PREFERENCE order

    // (a) a probe-absent FALLBACK is demoted to tail, NOT dropped; the pinned
    //     primary (Fable 5) stays rung 1. Catalog omits GLM — the real 2026-07-10
    //     case where usage-billed GLM/Kimi 429 at probe time.
    writeCatalog(new Date().toISOString(), [FABLE5, SOL, HAIKU, KIMI]); // GLM missing
    const derived = deriveChain({ BYOK_CATALOG_PATH: catPath } as any);
    check("Fable 5 (primary) stays rung 1", derived[0] === FABLE5, derived[0]);
    check("no rung is dropped (reorder, not filter)", sorted(derived) === sorted(ALL5), derived.join(","));
    check("probe-absent GLM demoted to tail", derived[derived.length - 1] === GLM, derived.join(","));
    check("live fallbacks precede demoted, in preference order", derived.join(",") === [FABLE5, SOL, HAIKU, KIMI, GLM].join(","), derived.join(","));

    // (a2) the primary itself probe-absent (transient 429) → STILL pinned rung 1
    writeCatalog(new Date().toISOString(), [SOL, GLM, HAIKU, KIMI]); // Fable 5 missing
    const primaryBlipped = deriveChain({ BYOK_CATALOG_PATH: catPath } as any);
    check("Fable 5 stays primary even when probe-absent (pinned, not gated)", primaryBlipped[0] === FABLE5, primaryBlipped[0]);
    check("all-live fallbacks keep preference order behind pinned primary", primaryBlipped.join(",") === ALL5.join(","), primaryBlipped.join(","));

    // (b) stale catalog → cold-start DEFAULT
    writeCatalog(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), [FABLE5]);
    check("stale catalog falls back to DEFAULT", deriveChain({ BYOK_CATALOG_PATH: catPath } as any).join(",") === DEFAULT_MODEL_CHAIN.join(","));

    // (c) empty models list → DEFAULT
    writeCatalog(new Date().toISOString(), []);
    check("empty catalog falls back to DEFAULT", deriveChain({ BYOK_CATALOG_PATH: catPath } as any).join(",") === DEFAULT_MODEL_CHAIN.join(","));

    // (d) missing file → DEFAULT
    check("missing catalog falls back to DEFAULT", deriveChain({ BYOK_CATALOG_PATH: path.join(tmp, "nope.json") } as any).join(",") === DEFAULT_MODEL_CHAIN.join(","));

    // (e) DEFAULT itself is the full byok ladder (Fable 5 primary, GLM demoted to rung 3, no vercel 402 tier)
    check("DEFAULT_MODEL_CHAIN is all byok (no vercel rung)", DEFAULT_MODEL_CHAIN.every((m) => m.startsWith("byok:")), DEFAULT_MODEL_CHAIN.join(","));
    check("DEFAULT rung 1 is Fable 5 primary", DEFAULT_MODEL_CHAIN[0] === FABLE5, DEFAULT_MODEL_CHAIN[0]);
    check("DEFAULT rung 3 is GLM (demoted off primary)", DEFAULT_MODEL_CHAIN[2] === GLM, DEFAULT_MODEL_CHAIN[2]);
    check("DEFAULT ends with Kimi", DEFAULT_MODEL_CHAIN[DEFAULT_MODEL_CHAIN.length - 1] === KIMI, DEFAULT_MODEL_CHAIN[DEFAULT_MODEL_CHAIN.length - 1]);

    // (f) FACTORY_MODEL_CHAIN overrides the derived chain entirely
    writeCatalog(new Date().toISOString(), [FABLE5, KIMI]);
    const overridden = loadModelChain({ BYOK_CATALOG_PATH: catPath, FACTORY_MODEL_CHAIN: "x:1, y:2" } as any);
    check("env override beats derived chain", overridden.join(",") === "x:1,y:2", overridden.join(","));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} model-chain selftest: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
