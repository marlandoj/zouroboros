#!/usr/bin/env bun
/**
 * Provider rotation for the agentic /zo/ask transport.
 *
 * The factory executes via /zo/ask — an AGENTIC endpoint: the child Zo runs the
 * full interview → seed → eval → execute → post-flight → gap-audit pipeline.
 * /zo/ask picks the backing LLM from the `model_name` provider prefix. When one
 * provider rate-limits (429) or transiently fails, we retry once, then rotate to
 * the next model_name in the chain — a DIFFERENT provider serving (ideally) the
 * SAME model, so agentic capability and output quality are preserved.
 *
 * Prefixes confirmed reachable THROUGH /zo/ask (re-probed 2026-07-04):
 *   byok:<id>                        → Synthetic.new (GLM-5.2) OR a DIRECT provider
 *                                      (e.g. byok:a3556112… routes DeepSeek-v4-pro
 *                                      DIRECT — 402 "Insufficient Balance" until the
 *                                      DeepSeek account is topped up; genuinely
 *                                      cross-provider, so re-add it once funded).
 *   vercel:anthropic/<m> | claude-*  → Anthropic (haiku + sonnet-4-6 probed OK).
 * DEAD through /zo/ask (do NOT put back — not a creds issue, a platform model-disable):
 *   openrouter:z-ai/glm-5.2 → 403 "Model is disabled: vercel:zai/glm-5.2". The
 *   platform remaps the openrouter prefix onto a DISABLED vercel:zai model; a valid
 *   OPENROUTER_API_KEY cannot revive it. Swapped to Anthropic Sonnet 4.6 (2026-07-04).
 *   Also dead: oc:, hf:, opencode: (→ 502 "Unknown provider"). Opencode would need
 *   its own byok:<uuid> to route.
 */

import * as fs from "fs";

// Same set the consensus-gate treats as transient (retry, then rotate).
export const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 529]);

/**
 * Failover chain source of truth.
 *
 * ZOU-546 post-mortem: the old fallback tier was two `vercel:anthropic/*` rungs
 * that shared ONE Vercel AI Gateway billing account. When that account hit a 402
 * "insufficient balance", BOTH rungs collapsed at once and the run exhausted the
 * chain. The fix moves the fallback tier onto flat-rate ("subscription") BYOK
 * configs — each a DIFFERENT vendor/account, none of which can 402 — and derives
 * the live set from the /zo/ask-probed byok-catalog (see deriveChain).
 *
 * Rungs (priority order, operator-set 2026-07-10):
 *   1. Claude Code Fable 5 — flat-rate flagship PRIMARY (402/429-immune subscription).
 *   2. Codex GPT 5.6 Sol   — flagship, separate vendor + account.
 *   3. Synthetic GLM-5.2   — usage-billed; demoted off primary while quota-429'd.
 *   4. Claude Code Haiku   — cheap subscription.
 *   5. Kimi K2.7-Code      — usage-billed, separate vendor.
 * Every rung routes through /zo/ask via its `byok:<uuid>` config. Override the
 * whole chain with FACTORY_MODEL_CHAIN (comma-separated model_names, priority
 * order) — e.g. to re-add a `vercel:anthropic/*` rung once that gateway is funded.
 */
// Vendor-diverse byok ladder, priority order (operator-set 2026-07-10 — Fable 5
// promoted to primary over GLM-5.2, which is usage-billed and persistently
// quota-429'd). Every id is a `byok:<uuid>` config routable through /zo/ask; the
// flat-rate "subscription" rungs (Fable 5, Sol, Haiku) are immune both to the 402
// that collapsed the old vercel tier (ZOU-546) and to probe-time 429s. deriveChain
// uses the /zo/ask-probed byok-catalog only to REORDER — demoting configs that
// were not live at the last probe to the tail — never to DROP a rung: the probe
// can't tell a transient 429 from a rotated UUID, and the usage-billed configs
// (GLM-5.2, Kimi) 429 at probe time (observed 2026-07-10 — a refresh 429'd both
// and would have evicted them). A genuinely-dead UUID simply sinks to the tail and
// costs one cheap non-retried 400 at runtime.
const BYOK_CHAIN_PREFERENCE = [
  "byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e", // Claude Code Fable 5   (claude flagship — PRIMARY)
  "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f", // Codex GPT 5.6 Sol     (gpt flagship, separate account)
  "byok:bb3d131d-749f-423b-a285-9f9efd103926", // Synthetic GLM-5.2     (usage-billed, currently 429-capped)
  "byok:461d8d6f-9616-4391-960e-3caea2a27829", // Claude Code Haiku 4.5 (cheap subscription)
  "byok:463350ac-4a49-4ceb-8653-042ecffa513f", // Kimi K2.7-Code        (usage-billed, separate vendor)
];

// Cold-start fallback: used verbatim when the byok-catalog is missing/stale, so
// an unrefreshed workspace still runs the full byok ladder (no vercel 402 tier).
export const DEFAULT_MODEL_CHAIN = [...BYOK_CHAIN_PREFERENCE];

const BYOK_CATALOG_STALE_MS = 14 * 24 * 60 * 60 * 1000; // matches catalog-byok probe TTL

function byokCatalogPath(env: Record<string, string | undefined>): string {
  return env.BYOK_CATALOG_PATH || (env.HOME ? `${env.HOME}/.zouroboros/byok-catalog.json` : "");
}

/** Ids live in the /zo/ask-probed byok-catalog, or null if the cache is
 *  missing, unreadable, empty, or staler than the probe TTL. */
function liveByokIds(env: Record<string, string | undefined>): Set<string> | null {
  const p = byokCatalogPath(env);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { fetched_at?: string; models?: { id?: string }[] };
    const age = Date.now() - Date.parse(raw.fetched_at ?? "");
    if (!Number.isFinite(age) || age > BYOK_CATALOG_STALE_MS) return null;
    const ids = new Set<string>();
    for (const m of raw.models ?? []) if (m.id) ids.add(m.id);
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Order the byok ladder by last-probed liveness WITHOUT dropping any rung: the
 * pinned primary (Fable 5) stays first, then the fallbacks that were live at the
 * last catalog probe (in preference order), then any that were probe-absent
 * (demoted — they MAY be dead, but are kept in case they were only transiently
 * rate-limited when probed; e.g. usage-billed GLM-5.2/Kimi 429 at probe time, so
 * a 429-capped GLM sinks below Haiku until its quota clears). Returns the plain
 * curated order when the catalog is missing/stale/empty. loadModelChain lets
 * FACTORY_MODEL_CHAIN override entirely.
 */
export function deriveChain(env: Record<string, string | undefined> = process.env): string[] {
  const live = liveByokIds(env);
  if (!live) return [...DEFAULT_MODEL_CHAIN];
  const [primary, ...fallbacks] = BYOK_CHAIN_PREFERENCE;
  const up = fallbacks.filter((id) => live.has(id));
  const down = fallbacks.filter((id) => !live.has(id));
  return [primary, ...up, ...down];
}

export function loadModelChain(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.FACTORY_MODEL_CHAIN?.trim();
  if (raw) {
    const chain = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length) return chain;
  }
  return deriveChain(env);
}

// Body-level markers that mean "rate limited / retry" even when the HTTP status
// itself is a generic wrapper (e.g. /zo/ask returns 502 wrapping a provider 429).
const RATE_LIMIT_MARKERS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "exceeded your subscription",
  "resource_exhausted",
  "too many requests",
  "overloaded",
  "429",
  "529",
];

export function isTransientBody(body: string): boolean {
  const b = body.toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => b.includes(m));
}

export interface AskAttempt {
  model: string;
  attempt: number; // 1 = first try, 2 = same-provider retry
  status: number | null; // null = threw (network / timeout)
  ok: boolean;
  detail: string;
}

export interface AskResult {
  output: string;
  model: string; // the provider model_name that actually served the result
  conversationId?: string;
  trail: AskAttempt[]; // full attempt-by-attempt failover trail
}

export type FetchLike = typeof fetch;

export interface AskOptions {
  url: string;
  token: string;
  input: string;
  chain: string[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxAttemptsPerModel?: 1 | 2;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CallOutcome {
  ok: boolean;
  status: number | null;
  output?: string;
  conversationId?: string;
  detail?: string;
  transient?: boolean;
}

async function callOnce(
  model: string,
  opts: AskOptions,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<CallOutcome> {
  try {
    const resp = await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        Authorization: opts.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ input: opts.input, model_name: model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    if (resp.ok) {
      try {
        const data = JSON.parse(text) as { output?: string; conversation_id?: string };
        return { ok: true, status: resp.status, output: data.output ?? "", conversationId: data.conversation_id };
      } catch {
        return { ok: true, status: resp.status, output: text }; // non-JSON 200 → body is the output
      }
    }
    return {
      ok: false,
      status: resp.status,
      detail: text.slice(0, 300).replace(/\s+/g, " "),
      transient: TRANSIENT_STATUSES.has(resp.status) || isTransientBody(text),
    };
  } catch (e: any) {
    // Network error / timeout — treat as transient (retry once, then rotate).
    return { ok: false, status: null, detail: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`, transient: true };
  }
}

/**
 * Call /zo/ask, rotating model_name across the chain on transient failures. Each
 * model gets ONE same-provider retry (after retryDelayMs) before rotation.
 * Resolves with the first success; rejects with the full trail attached (.trail)
 * if every model in the chain is exhausted.
 */
export async function askWithFailover(opts: AskOptions): Promise<AskResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000; // agentic runs are long-lived
  const maxAttemptsPerModel = opts.maxAttemptsPerModel ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 2500;
  const sleep = opts.sleep ?? defaultSleep;
  const chain = opts.chain.length ? opts.chain : [...DEFAULT_MODEL_CHAIN];
  const trail: AskAttempt[] = [];

  for (const model of chain) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      const r = await callOnce(model, opts, fetchImpl, timeoutMs);
      if (r.ok) {
        trail.push({ model, attempt, status: r.status, ok: true, detail: "ok" });
        return { output: r.output ?? "", model, conversationId: r.conversationId, trail };
      }
      trail.push({ model, attempt, status: r.status, ok: false, detail: r.detail ?? "" });
      if (r.transient && attempt < maxAttemptsPerModel) {
        await sleep(retryDelayMs); // one same-provider retry
        continue;
      }
      break; // non-transient, or transient after retry → rotate to next model
    }
  }

  const summary = trail.map((t) => `${t.model}#${t.attempt}=${t.status ?? "throw"}`).join(" → ");
  const err = new Error(
    `/zo/ask failover exhausted after ${trail.length} attempt(s) across ${chain.length} model(s): ${summary}`
  );
  (err as Error & { trail: AskAttempt[] }).trail = trail;
  throw err;
}

/** Compact one-line rendering of a failover trail for logs / exec records. */
export function formatTrail(trail: AskAttempt[]): string {
  return trail.map((t) => `${t.model}#${t.attempt}=${t.ok ? "ok" : (t.status ?? "throw")}`).join(" → ");
}
