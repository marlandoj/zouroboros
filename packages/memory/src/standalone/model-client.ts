// =============================================================================
// model-client.ts — Unified model provider abstraction
//
// Provides a clean interface that routes to OpenAI or Anthropic based on env
// vars. (On-host Ollama / local models were removed 2026-05-29: the host has no
// GPU. A REMOTE local inference tier — vLLM/SGLang on the Hetzner GPU annex —
// was added 2026-07-04 as a 4th MoA proposer; see the MoA block + moa-local-ab.ts.)
//
// Usage:
//   import { generate, embeddings, modelHealthCheck } from "./model-client";
//
//   const { content, latency_ms } = await generate({
//     prompt: "Hello world",
//     workload: "gate",
//   });
//
// Env vars by workload (all optional — defaults to OpenAI models):
//   ZO_MODEL_GATE         → memory gate classifier
//   ZO_MODEL_HYDE         → HyDE query expansion
//   ZO_MODEL_EXTRACTION   → fact extraction
//   ZO_MODEL_SUMMARIZATION → episode summarization
//   ZO_MODEL_BRIEFING     → session briefing
//   ZO_MODEL_CAPTURE      → inline capture
//   ZO_MODEL_CONVERSATION  → conversation capture
//   ZO_MODEL_EMBEDDING    → embedding model
//   ZO_MODEL_EVOLUTION    → STaR procedure rationale + step proposal (M9)
//
// Model spec format: "provider:model-id"
//   openai:gpt-4o-mini    → OpenAI
//   anthropic:haiku        → Anthropic (via Zo OAuth)
//   moa:default            → Mixture-of-Agents synthesis (cheap, non-Anthropic, via OpenRouter)
//   moa:<aggregator-slug>  → MoA with a custom aggregator (default proposer set)
//
//   Bare names (no colon) default to OpenAI: "gpt-4o-mini" → "openai:gpt-4o-mini"
//
// The "moa" provider is a dormant-but-armed synthesis socket: a workload only routes
// here when its ZO_MODEL_<WORKLOAD> spec is explicitly set to "moa:...". It reached
// Opus-4.7 parity on ZouroBench memory synthesis at ~3.6x lower cost and makes no
// Anthropic call. Adding it changes no default — every workload still defaults to OpenAI.
//
// Cost tracking: every call returns { content, latency_ms, provider, model, cost_usd }
// =============================================================================

import { join } from "path";
import { getWorkspaceRoot } from "zouroboros-core";

export type Provider = "openai" | "anthropic" | "moa" | "openrouter";
export type Workload =
  | "gate" | "hyde" | "extraction"
  | "summarization" | "briefing"
  | "capture" | "conversation" | "embedding"
  | "evolution";

export interface GenerateOptions {
  prompt: string;
  system?: string;
  workload: Workload;
  model?: string;         // overrides ZO_MODEL_<WORKLOAD>
  temperature?: number;
  maxTokens?: number;
  json?: boolean;          // if true, request structured JSON response
  max_age?: number;        // Anthropic max_age parameter
}

export interface GenerateResult {
  content: string;
  latency_ms: number;
  provider: Provider;
  model: string;
  cost_usd: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface EmbedResult {
  embedding: number[];
  latency_ms: number;
  provider: Provider;
  model: string;
  cost_usd: number;
  error?: string;
}

export interface HealthResult {
  available: boolean;
  latency_ms: number;
  error?: string; cost_usd?: number;
}

// ─── Workload defaults ────────────────────────────────────────────────────────

const WORKLOAD_TEMP: Record<Workload, number> = {
  gate: 0.1, hyde: 0.3, extraction: 0.2,
  summarization: 0.4, briefing: 0.5,
  capture: 0.4, conversation: 0.4, embedding: 0.0,
  evolution: 0.3,
};

const WORKLOAD_MAX_TOKENS: Record<Workload, number> = {
  gate: 150, hyde: 200, extraction: 400,
  summarization: 800, briefing: 400,
  capture: 600, conversation: 600, embedding: 2048,
  evolution: 1500,
};

// Shorter timeouts + retry budget for latency-sensitive workloads
const WORKLOAD_TIMEOUT_MS: Record<Workload, number> = {
  gate: 15000, hyde: 15000, extraction: 15000,
  summarization: 30000, briefing: 30000,
  capture: 20000, conversation: 20000, embedding: 15000,
  evolution: 30000,
};

const WORKLOAD_MAX_RETRIES: Record<Workload, number> = {
  gate: 1, hyde: 1, extraction: 2,
  summarization: 1, briefing: 1,
  capture: 1, conversation: 1, embedding: 1,
  evolution: 1,
};

// ─── Model spec parser ────────────────────────────────────────────────────────

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "moa", "openrouter"];

function parseModelSpec(spec: string): { provider: Provider; model: string } {
  if (!spec || typeof spec !== "string") return { provider: "openai", model: "gpt-4o-mini" };
  const colon = spec.indexOf(":");
  if (colon < 0) {
    // Bare name — default to OpenAI
    return { provider: "openai", model: spec };
  }
  const prefix = spec.slice(0, colon).toLowerCase();
  if (ALL_PROVIDERS.includes(prefix as Provider)) {
    return { provider: prefix as Provider, model: spec.slice(colon + 1) };
  }
  return { provider: "openai", model: spec };
}

// ─── Workload resolver ────────────────────────────────────────────────────────

const WORKLOAD_ENV: Record<Workload, string> = {
  gate: "ZO_MODEL_GATE",
  hyde: "ZO_MODEL_HYDE",
  extraction: "ZO_MODEL_EXTRACTION",
  summarization: "ZO_MODEL_SUMMARIZATION",
  briefing: "ZO_MODEL_BRIEFING",
  capture: "ZO_MODEL_CAPTURE",
  conversation: "ZO_MODEL_CONVERSATION",
  embedding: "ZO_MODEL_EMBEDDING",
  evolution: "ZO_MODEL_EVOLUTION",
};

function loadModelEnv(): void {
  try {
    const { readFileSync } = require("fs");
    const envPath = "/home/.z/config/model.env";
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      let line2 = trimmed;
      // Strip leading "export " prefix (shell-style)
      if (line2.startsWith("export ")) line2 = line2.slice(7);
      const eqIdx = line2.indexOf("=");
      if (eqIdx < 0) continue;
      const key = line2.slice(0, eqIdx).trim();
      const val = line2.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* no model.env */ }
}

function resolveModel(workload: Workload, explicitModel?: string): { provider: Provider; model: string } {
  loadModelEnv();
  const envKey = WORKLOAD_ENV[workload];
  const spec = explicitModel || process.env[envKey] || "";
  if (spec) return parseModelSpec(spec);
  const defaults: Record<Workload, string> = {
    gate: "openai:gpt-4o-mini",
    hyde: "openai:gpt-4o-mini",
    extraction: "openai:gpt-4o-mini",
    summarization: "openai:gpt-4o-mini",
    briefing: "openai:gpt-4o-mini",
    capture: "openai:gpt-4o-mini",
    conversation: "openai:gpt-4o-mini",
    embedding: "openai:text-embedding-3-small",
    evolution: "openai:gpt-4o-mini",
  };
  return parseModelSpec(defaults[workload]);
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_TOKEN = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY || "";

async function openaiGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!OPENAI_TOKEN) throw new Error("OPENAI_API_KEY not set");
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);
  const temperature = opts.temperature ?? WORKLOAD_TEMP[opts.workload];
  const maxTokens = opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload];

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
    if (!opts.system) messages.unshift({ role: "system", content: "You are a JSON generator. Respond ONLY with valid JSON, no markdown or explanation." });
  }

  const timeout = WORKLOAD_TIMEOUT_MS[opts.workload] ?? 30000;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`[openai/${model}] OpenAI error ${resp.status}: ${errText}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.usage;
  const latency_ms = Date.now() - start;

  // Cost: gpt-4o-mini = $0.07/1K input + $0.28/1K output
  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || 0;
  const cost_usd = (inputTokens * 0.07 + outputTokens * 0.28) / 1000;

  return {
    content,
    latency_ms,
    provider: "openai",
    model,
    cost_usd: Math.max(cost_usd, 0.00001),
    usage: usage ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined,
  };
}

async function openaiEmbeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  if (!OPENAI_TOKEN) throw new Error("OPENAI_API_KEY not set");
  const { model } = resolveModel("embedding", explicitModel);
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_TOKEN}`,
    },
    body: JSON.stringify({ input: text, model: model || "text-embedding-3-small" }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[openai] Embeddings error ${resp.status}`);
  const data = await resp.json() as { data?: Array<{ embedding?: number[] }>; usage?: unknown };
  const embedding = data.data?.[0]?.embedding || [];
  return { embedding, latency_ms: 0, provider: "openai", model, cost_usd: 0.00001 };
}

// ─── Local embedding tier (BGE-M3 / NV-Embed-v2 on the Hetzner GPU annex) ────
//
// A self-hosted embedding model served by HuggingFace text-embeddings-inference
// (TEI) or Infinity on the compute annex (ZOU-414), exposing an OpenAI-compatible
// /v1/embeddings endpoint reached over HTTP. Dormant unless ZO_EMBED_BASE_URL is
// set — when unset embeddings() is byte-identical to the OpenAI
// text-embedding-3-small default (no behavior change). When set, embeddings()
// short-circuits to localEmbeddings() before the provider switch. This is a
// REMOTE self-hosted endpoint, not the on-host Ollama paths removed 2026-05-29.
//
// ENV (all optional — local tier stays dormant otherwise):
//   ZO_EMBED_BASE_URL   → e.g. http://hetzner-gpu:8080   (REQUIRED to arm)
//   ZO_EMBED_MODEL      → served model id (default: bge-m3)
//   ZO_EMBED_API_KEY    → optional bearer
//   ZO_EMBED_DIM        → vector dim (default: 1024 for BGE-M3; informational)
//   ZO_EMBED_USD_PER_1K → amortized self-host cost per 1K tokens (default: 0 = free-at-API)

const EMBED_LOCAL_BASE_URL = process.env.ZO_EMBED_BASE_URL || "";
const EMBED_LOCAL_MODEL = process.env.ZO_EMBED_MODEL || "bge-m3";
const EMBED_LOCAL_TOKEN = process.env.ZO_EMBED_API_KEY || "";
const EMBED_LOCAL_DIM = Number(process.env.ZO_EMBED_DIM || 1024) || 1024;
const EMBED_LOCAL_USD_PER_1K = Number(process.env.ZO_EMBED_USD_PER_1K || 0) || 0;
const EMBED_LOCAL_ENABLED = EMBED_LOCAL_BASE_URL.length > 0;

export function localEmbedTierArmed(): boolean { return EMBED_LOCAL_ENABLED; }

export function localEmbedConfig(): { baseURL: string; model: string; dim: number; armed: boolean } {
  return { baseURL: EMBED_LOCAL_BASE_URL, model: EMBED_LOCAL_MODEL, dim: EMBED_LOCAL_DIM, armed: EMBED_LOCAL_ENABLED };
}

/**
 * Self-hosted embeddings via an OpenAI-compatible /v1/embeddings endpoint
 * (BGE-M3 / NV-Embed-v2 served by TEI/Infinity). One retry, 60s timeout.
 * provider label stays "openai"; model carries "local/<model>" for attribution.
 * Throws [local/<model>] <err> on failure.
 */
export async function localEmbeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  if (!EMBED_LOCAL_ENABLED) throw new Error(`[local/${EMBED_LOCAL_MODEL}] ZO_EMBED_BASE_URL not configured`);
  const start = Date.now();
  const model = (explicitModel && explicitModel !== "text-embedding-3-small")
    ? explicitModel
    : EMBED_LOCAL_MODEL;
  const url = `${EMBED_LOCAL_BASE_URL.replace(/\/+$/, "")}/v1/embeddings`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (EMBED_LOCAL_TOKEN) headers["Authorization"] = `Bearer ${EMBED_LOCAL_TOKEN}`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: text, model }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) { lastErr = `HTTP ${resp.status}`; continue; }
      const data = await resp.json() as { data?: Array<{ embedding?: number[] }>; usage?: unknown };
      const embedding = data.data?.[0]?.embedding || [];
      if (embedding.length === 0) { lastErr = "empty embedding"; continue; }
      // Token estimate: ~4 chars/token; refined if the server returns usage.
      const tokEst = Math.max(1, Math.round(text.length / 4));
      const cost = (tokEst * EMBED_LOCAL_USD_PER_1K) / 1000;
      return {
        embedding,
        latency_ms: Date.now() - start,
        provider: "openai",
        model: `local/${model}`,
        cost_usd: Math.max(cost, 0.0),
      };
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`[local/${model}] ${lastErr}`);
}

export async function localEmbedHealthCheck(): Promise<HealthResult> {
  const start = Date.now();
  if (!EMBED_LOCAL_ENABLED) return { available: false, latency_ms: Date.now() - start, error: "ZO_EMBED_BASE_URL not set" };
  try {
    const modelsURL = `${EMBED_LOCAL_BASE_URL.replace(/\/+$/, "")}/v1/models`;
    const headers: Record<string, string> = {};
    if (EMBED_LOCAL_TOKEN) headers["Authorization"] = `Bearer ${EMBED_LOCAL_TOKEN}`;
    const resp = await fetch(modelsURL, { headers, signal: AbortSignal.timeout(5000) });
    return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  } catch (e) {
    return { available: false, latency_ms: Date.now() - start, error: String(e) };
  }
}

// ─── Anthropic (via Zo OAuth) ────────────────────────────────────────────────

// Zo OAuth: use the Zo platform identity token to call Anthropic through the Zo API
const ZO_TOKEN = process.env.ZO_CLIENT_IDENTITY_TOKEN || "";
const ZO_API_BASE = "https://api.zo.computer";

async function anthropicGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!ZO_TOKEN) throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set — Zo OAuth required for Anthropic");
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);

  // Map to Zo /zo/ask API which routes to Anthropic
  const system = opts.system
    ? `${opts.system}\n\nRespond ONLY with valid JSON.`
    : "Respond ONLY with valid JSON.";

  const resp = await fetch(`${ZO_API_BASE}/zo/ask`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ZO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: opts.prompt,
      model_name: `vercel:anthropic/${model}`,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[anthropic/${model}] Zo API error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as { output?: string; latency_ms?: number };
  const content = data.output || "";
  const latency_ms = data.latency_ms || Date.now() - start;

  return { content, latency_ms, provider: "anthropic", model, cost_usd: 0.001 };
}

async function anthropicEmbeddings(_text: string): Promise<EmbedResult> {
  return { embedding: [], latency_ms: 0, provider: "anthropic", model: "unknown", cost_usd: 0, error: "Anthropic embeddings not supported via Zo OAuth" };
}

// ─── MoA (Mixture-of-Agents via OpenRouter) ──────────────────────────────────
//
// Cheap, non-Anthropic synthesis socket. Several open proposer models draft in
// parallel; one aggregator critically synthesizes a single answer. Mirrors the
// reasoning-model contract proven in the MoA-Fable eval: max_tokens >= 4096,
// content→reasoning fallback, one retry on empty/error. Dormant unless a workload's
// spec is set to "moa:..."; the spec's model part overrides the aggregator slug.

const OPENROUTER_TOKEN = process.env.OPENROUTER_API_KEY || "";

// ─── Local inference tier (vLLM / SGLang on the Hetzner GPU annex) ───────────
//
// The 4th MoA proposer: a self-hosted DeepSeek-V4 / Qwen-3 served by vLLM or
// SGLang on the compute annex (ZOU-414), exposing an OpenAI-compatible
// /v1/chat/completions endpoint reached over HTTP. Dormant unless
// ZO_VLLM_BASE_URL is set — when unset the MoA lineup is byte-identical to the
// 3-vendor default (no behavior change). When set, the local proposer joins as
// a 4th drafter; its failure is isolated by Promise.allSettled (same graceful-
// degradation contract as a vendor 5xx). Closes the vendor-agnostic generation
// socket (one-env-var fallback if a vendor deprecates/reprices) and enables
// same-base-model vendor-vs-self A/B (see moa-local-ab.ts). This is a REMOTE
// self-hosted endpoint, not the on-host Ollama paths removed 2026-05-29.
//
// ENV (all optional — local tier stays dormant otherwise):
//   ZO_VLLM_BASE_URL   → e.g. http://hetzner-gpu:8000/v1   (REQUIRED to arm)
//   ZO_VLLM_MODEL      → served model id (default: deepseek-v4)
//   ZO_VLLM_API_KEY    → optional bearer (vLLM accepts a dummy key)
//   ZO_VLLM_USD_PER_1K → amortized self-host cost per 1K tokens (default: 0 = free-at-API)

export type ProposerKind = "vendor" | "local";
export interface Proposer {
  slug: string;        // attribution label, e.g. "z-ai/glm-5.2" or "local/deepseek-v4"
  kind: ProposerKind;
  model: string;     // model id sent to the endpoint
  baseURL?: string;  // full chat-completions URL (local tier); undefined → OpenRouter
  token?: string;     // bearer token (local tier); undefined → OPENROUTER_TOKEN
}

const VLLM_BASE_URL = process.env.ZO_VLLM_BASE_URL || "";
const VLLM_MODEL = process.env.ZO_VLLM_MODEL || "deepseek-v4";
const VLLM_TOKEN = process.env.ZO_VLLM_API_KEY || "";
const VLLM_USD_PER_1K = Number(process.env.ZO_VLLM_USD_PER_1K || 0) || 0;
const VLLM_ENABLED = VLLM_BASE_URL.length > 0;

const VENDOR_PROPOSERS: Proposer[] = [
  { slug: "z-ai/glm-5.2", kind: "vendor", model: "z-ai/glm-5.2" },
  { slug: "moonshotai/kimi-k2.6", kind: "vendor", model: "moonshotai/kimi-k2.6" },
  { slug: "deepseek/deepseek-v4-pro", kind: "vendor", model: "deepseek/deepseek-v4-pro" },
];

const LOCAL_PROPOSER: Proposer = {
  slug: `local/${VLLM_MODEL}`,
  kind: "local",
  model: VLLM_MODEL,
  baseURL: VLLM_BASE_URL ? `${VLLM_BASE_URL.replace(/\/+$/, "")}/chat/completions` : undefined,
  token: VLLM_TOKEN || undefined,
};

// Active lineup: 3 vendor proposers by default; the local tier joins as the 4th
// when ZO_VLLM_BASE_URL is set. Same dormancy contract as the moa provider —
// armed only when explicitly configured, byte-identical otherwise.
const MOA_PROPOSERS: Proposer[] = VLLM_ENABLED
  ? [...VENDOR_PROPOSERS, LOCAL_PROPOSER]
  : VENDOR_PROPOSERS;

const MOA_DEFAULT_AGGREGATOR = "z-ai/glm-5.2";
const MOA_MIN_TOKENS = 4096; // reasoning proposers starve content below this
// Blended OpenRouter rate for the open proposer set (~$0.3–0.6/M); approximate.
const MOA_USD_PER_1K_TOKENS = 0.0005;

async function openRouterChat(
  model: string,
  system: string | undefined,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; inTok: number; outTok: number }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENROUTER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, temperature, max_tokens: Math.max(maxTokens, MOA_MIN_TOKENS) }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) { lastErr = `HTTP ${resp.status}`; continue; }
      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string; reasoning?: string; reasoning_content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = data.choices?.[0]?.message ?? {};
      const text = ((msg.content ?? "").toString().trim()) || ((msg.reasoning ?? msg.reasoning_content ?? "").toString().trim());
      if (text) return { text, inTok: data.usage?.prompt_tokens ?? 0, outTok: data.usage?.completion_tokens ?? 0 };
      lastErr = "empty content and reasoning";
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`[moa/${model}] ${lastErr}`);
}

// Local-tier chat: hits a vLLM/SGLang OpenAI-compatible endpoint. No OpenRouter
// token required; an optional bearer (ZO_VLLM_API_KEY) is forwarded if set.
export async function localChat(
  proposer: Proposer,
  system: string | undefined,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; inTok: number; outTok: number }> {
  if (!proposer.baseURL) throw new Error(`[local/${proposer.model}] ZO_VLLM_BASE_URL not configured`);
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (proposer.token) headers["Authorization"] = `Bearer ${proposer.token}`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(proposer.baseURL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: proposer.model,
          messages,
          temperature,
          max_tokens: Math.max(maxTokens, MOA_MIN_TOKENS),
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) { lastErr = `HTTP ${resp.status}`; continue; }
      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = (data.choices?.[0]?.message?.content ?? "").toString().trim();
      if (text) return { text, inTok: data.usage?.prompt_tokens ?? 0, outTok: data.usage?.completion_tokens ?? 0 };
      lastErr = "empty content";
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`[local/${proposer.model}] ${lastErr}`);
}

// Unified proposer dispatch — vendor proposers go to OpenRouter; the local
// tier goes to its self-hosted endpoint. Exported so the A/B harness
// (moa-local-ab.ts) exercises the SAME dispatch path production uses.
export async function proposerChat(
  p: Proposer,
  system: string | undefined,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; inTok: number; outTok: number }> {
  return p.kind === "local"
    ? localChat(p, system, prompt, maxTokens, temperature)
    : openRouterChat(p.model, system, prompt, maxTokens, temperature);
}

// Public surface for the A/B harness + health probing.
export function getMoaProposers(): Proposer[] { return MOA_PROPOSERS.slice(); }
export function localTierArmed(): boolean { return VLLM_ENABLED; }

export async function localInferenceHealthCheck(): Promise<HealthResult> {
  const start = Date.now();
  if (!VLLM_ENABLED) return { available: false, latency_ms: Date.now() - start, error: "ZO_VLLM_BASE_URL not set" };
  try {
    const modelsURL = VLLM_BASE_URL.replace(/\/+$/, "") + "/models";
    const headers: Record<string, string> = {};
    if (VLLM_TOKEN) headers["Authorization"] = `Bearer ${VLLM_TOKEN}`;
    const resp = await fetch(modelsURL, { headers, signal: AbortSignal.timeout(5000) });
    return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  } catch (e) {
    return { available: false, latency_ms: Date.now() - start, error: String(e) };
  }
}

async function moaGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!OPENROUTER_TOKEN) throw new Error("OPENROUTER_API_KEY not set — required for moa provider");
  const start = Date.now();
  const { model: aggregator } = resolveModel(opts.workload, opts.model);
  const aggSlug = !aggregator || aggregator === "default" ? MOA_DEFAULT_AGGREGATOR : aggregator;
  const temperature = opts.temperature ?? WORKLOAD_TEMP[opts.workload];
  const maxTokens = opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload];
  const system = opts.json
    ? `${opts.system ? opts.system + "\n\n" : ""}Respond ONLY with valid JSON, no markdown or explanation.`
    : opts.system;

  const proposers = getMoaProposers();
  let vendorInTok = 0, vendorOutTok = 0, localInTok = 0, localOutTok = 0;
  const drafts = await Promise.allSettled(
    proposers.map((p) => proposerChat(p, system, opts.prompt, maxTokens, temperature)),
  );
  const usable: string[] = [];
  drafts.forEach((d, i) => {
    if (d.status === "fulfilled" && d.value.text) {
      usable.push(`[Response ${i + 1} — ${proposers[i].slug}]\n${d.value.text}`);
      if (proposers[i].kind === "local") { localInTok += d.value.inTok; localOutTok += d.value.outTok; }
      else { vendorInTok += d.value.inTok; vendorOutTok += d.value.outTok; }
    }
  });
  if (!usable.length) throw new Error("[moa] all proposers failed");

  const aggPrompt = `You have been provided with a set of responses from several AI models to the task below. Synthesize them into a single, high-quality answer. Critically evaluate the responses — they may be incomplete, partially correct, or contradictory. Do not merely copy; produce the most accurate, complete answer to the original task, following its formatting instructions exactly.

=== MODEL RESPONSES ===
${usable.join("\n\n")}

=== ORIGINAL TASK (answer this) ===
${opts.prompt}`;
  // Aggregator stays vendor (GLM-5.2 via OpenRouter); the local tier is a proposer.
  const agg = await openRouterChat(aggSlug, system, aggPrompt, maxTokens, temperature);
  vendorInTok += agg.inTok; vendorOutTok += agg.outTok;

  const inTok = vendorInTok + localInTok;
  const outTok = vendorOutTok + localOutTok;
  const vendorCost = (vendorInTok + vendorOutTok) * MOA_USD_PER_1K_TOKENS / 1000;
  const localCost = (localInTok + localOutTok) * VLLM_USD_PER_1K / 1000;
  const cost_usd = Math.max(vendorCost + localCost, 0.00001);

  return {
    content: agg.text,
    latency_ms: Date.now() - start,
    provider: "moa",
    model: `moa(${aggSlug})`,
    cost_usd,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

async function openrouterGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const token = process.env.OPENROUTER_API_KEY || '';
  if (!token) throw new Error('OPENROUTER_API_KEY not set');
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? WORKLOAD_TEMP[opts.workload],
    max_tokens: opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload],
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'HTTP-Referer': 'https://marlandoj.zo.computer',
      'X-Title': 'ZoMemory',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WORKLOAD_TIMEOUT_MS[opts.workload] ?? 30_000),
  });
  if (!resp.ok) throw new Error(`[openrouter/${model}] OpenRouter error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string; reasoning?: string; reasoning_content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = data.choices?.[0]?.message ?? {};
  const content = (message.content ?? message.reasoning ?? message.reasoning_content ?? '').toString();
  if (!content.trim()) throw new Error(`[openrouter/${model}] empty response`);
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  return {
    content,
    latency_ms: Date.now() - start,
    provider: 'openrouter',
    model,
    cost_usd: Math.max((inputTokens + outputTokens) * 0.0005 / 1000, 0.00001),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

async function moaEmbeddings(_text: string): Promise<EmbedResult> {
  return { embedding: [], latency_ms: 0, provider: "moa", model: "unknown", cost_usd: 0, error: "moa provider does not support embeddings" };
}

// ─── Health checks ────────────────────────────────────────────────────────────

export async function modelHealthCheck(provider: Provider): Promise<HealthResult> {
  const start = Date.now();
  try {
    if (provider === "openai" && OPENAI_TOKEN) {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${OPENAI_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    if (provider === "anthropic" && ZO_TOKEN) {
      const resp = await fetch(`${ZO_API_BASE}/zo/ask`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ZO_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", model_name: "vercel:anthropic/haiku" }),
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    if (provider === "moa" && OPENROUTER_TOKEN) {
      const resp = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { "Authorization": `Bearer ${OPENROUTER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    return { available: false, latency_ms: Date.now() - start, error: "No credentials" };
  } catch (e) {
    return { available: false, latency_ms: Date.now() - start, error: String(e) };
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_WORKLOADS: Workload[] = ["gate", "extraction", "summarization", "briefing", "evolution"];

// Simple JSON file logger — zero dependencies, non-blocking
function logCall(result: GenerateResult, workload: Workload): void {
  if (!LOG_WORKLOADS.includes(workload)) return;
  try {
    const LOG_FILE = join(getWorkspaceRoot(), ".zo/memory/model-call-log.jsonl");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      workload,
      provider: result.provider,
      model: result.model,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
    }) + "\n";
    // Bun: append to file without reading whole file
    const { writeFileSync, appendFileSync, existsSync } = require("fs");
    appendFileSync(LOG_FILE, entry);
  } catch { /* non-fatal */ }
}

function logEmbedCall(result: EmbedResult): void {
  // skip embedding logs for now
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const { provider } = resolveModel(opts.workload, opts.model);
  const maxRetries = WORKLOAD_MAX_RETRIES[opts.workload] ?? 1;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let result: GenerateResult;
      switch (provider) {
        case "openai":    result = await openaiGenerate(opts); break;
        case "anthropic": result = await anthropicGenerate(opts); break;
        case "moa":       result = await moaGenerate(opts); break;
        case "openrouter": result = await openrouterGenerate(opts); break;
      }
      logCall(result!, opts.workload);
      return result!;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export async function embeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  // Local embedding tier (ZOU-420): dormant-until-armed drop-in. When
  // ZO_EMBED_BASE_URL is set, short-circuit to the self-hosted endpoint
  // (BGE-M3/NV-Embed-v2 via TEI/Infinity); otherwise the provider switch below
  // is byte-identical to the pre-ZOU-420 OpenAI default.
  if (EMBED_LOCAL_ENABLED) return localEmbeddings(text, explicitModel);
  const { provider, model } = resolveModel("embedding", explicitModel);
  switch (provider) {
    case "openai":    { const r = await openaiEmbeddings(text, model); logEmbedCall(r); return r; }
    case "anthropic": return anthropicEmbeddings(text);
    case "moa":       return moaEmbeddings(text);
    case "openrouter": return openaiEmbeddings(text, model);
  }
}
