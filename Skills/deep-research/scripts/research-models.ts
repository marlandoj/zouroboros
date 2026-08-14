import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  callMoaModel,
  DEFAULT_PRODUCTION_MOA_LINEUP,
  resolveProductionMoaLineup,
  type MoaCallResult,
} from "../../consensus-gate/scripts/moa-runtime";

const CONSENSUS_GATE = "/home/workspace/Skills/consensus-gate/scripts/consensus-gate.ts";

export function researchConsensusTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.DEEP_RESEARCH_CONSENSUS_TIMEOUT_MS || "120000", 10);
  if (!Number.isFinite(parsed)) return 120000;
  return Math.min(Math.max(parsed, 60_000), 12 * 60_000);
}

type ModelClient = typeof import("../../zo-memory-system/scripts/model-client");

let modelClientPromise: Promise<ModelClient> | undefined;

async function modelClient(): Promise<ModelClient> {
  modelClientPromise ??= import("../../zo-memory-system/scripts/model-client");
  return modelClientPromise;
}

export interface ModelTelemetry {
  provider: string;
  model: string;
  latency_ms: number;
  cost_usd: number;
  lineup_source?: string;
  proposers_requested?: string[];
  proposers_used?: string[];
  aggregator_requested?: string;
  aggregator_used?: string;
}

export interface ResearchGeneration {
  content: string;
  telemetry: ModelTelemetry;
}

export interface EvidenceSource {
  id: string;
  type: string;
  title: string;
  url: string;
  text: string;
}

export interface EvidenceClaim {
  sourceIds: string[];
}

export interface GateDecision {
  consensus_id: string;
  status: "passed" | "rejected" | "escalate";
  pass: boolean;
  confidence: number;
  objections: string[];
  lineup_source?: string;
  panel_fingerprint?: string;
  excluded_author?: string;
  input_sha256?: string;
  raw: Record<string, unknown>;
}

function configuredAggregator(defaultAggregator: string): string {
  const configured = (process.env.ZO_MODEL_RESEARCH || "moa:default").trim();
  if (!configured.startsWith("moa:")) {
    throw new Error("ZO_MODEL_RESEARCH must use the MoA provider (for example, moa:default)");
  }
  const requested = configured.slice(4).trim();
  return !requested || requested === "default" ? defaultAggregator : requested;
}

async function callProposers(
  models: string[],
  prompt: string,
  options: { system?: string; temperature: number; maxTokens: number },
): Promise<MoaCallResult[]> {
  return Promise.all(models.map((model) => callMoaModel(model, prompt, options)));
}

export async function generateResearch(
  prompt: string,
  options: { system?: string; temperature?: number; maxTokens?: number; json?: boolean } = {},
): Promise<ResearchGeneration> {
  const started = Date.now();
  const resolved = resolveProductionMoaLineup(DEFAULT_PRODUCTION_MOA_LINEUP);
  const requestedProposers = [...resolved.proposers];
  const requestedAggregator = configuredAggregator(resolved.aggregator);
  const generationOptions = {
    system: options.json
      ? `${options.system ? `${options.system}\n\n` : ""}Respond ONLY with valid JSON, no markdown or explanation.`
      : options.system,
    temperature: options.temperature ?? 0.3,
    maxTokens: options.maxTokens ?? 8192,
  };

  let lineupSource: ModelTelemetry["lineup_source"] = resolved.source;
  let proposerModels = [...resolved.proposers];
  let aggregatorModel = requestedAggregator;
  let drafts = await callProposers(proposerModels, prompt, generationOptions);
  if (drafts.filter((draft) => draft.ok && draft.text).length < 2 && resolved.source !== "fallback") {
    proposerModels = [...DEFAULT_PRODUCTION_MOA_LINEUP.proposers];
    aggregatorModel = proposerModels.includes(aggregatorModel)
      ? DEFAULT_PRODUCTION_MOA_LINEUP.aggregator
      : aggregatorModel;
    lineupSource = "fallback-after-failure";
    drafts = await callProposers(proposerModels, prompt, generationOptions);
  }

  const usable = drafts.flatMap((draft, index) => draft.ok && draft.text
    ? [{ text: `[Response ${index + 1} — ${proposerModels[index]}]\n${draft.text}`, model: proposerModels[index], draft }]
    : []);
  if (usable.length < 2) {
    throw new Error(`[moa] only ${usable.length} proposer succeeded; at least 2 are required`);
  }

  const aggregationPrompt = `Synthesize the model responses below into one accurate, complete answer to the original task. Critically resolve omissions and contradictions, and follow the original formatting instructions exactly.\n\n` +
    `=== MODEL RESPONSES ===\n${usable.map((item) => item.text).join("\n\n")}\n\n` +
    `=== ORIGINAL TASK ===\n${prompt}`;
  let aggregate = await callMoaModel(aggregatorModel, aggregationPrompt, generationOptions);
  if ((!aggregate.ok || !aggregate.text) && aggregatorModel !== DEFAULT_PRODUCTION_MOA_LINEUP.aggregator) {
    if (proposerModels.includes(DEFAULT_PRODUCTION_MOA_LINEUP.aggregator)) {
      throw new Error("[moa] canonical fallback aggregator overlaps the active proposer set");
    }
    aggregatorModel = DEFAULT_PRODUCTION_MOA_LINEUP.aggregator;
    lineupSource = "fallback-after-failure";
    aggregate = await callMoaModel(aggregatorModel, aggregationPrompt, generationOptions);
  }
  if (!aggregate.ok || !aggregate.text.trim()) {
    throw new Error(`[moa/${aggregatorModel}] ${aggregate.error || "aggregator returned empty content"}`);
  }

  const calls = [...usable.map((item) => item.draft), aggregate];
  return {
    content: aggregate.text,
    telemetry: {
      provider: "moa",
      model: `moa(${aggregatorModel})`,
      latency_ms: Date.now() - started,
      cost_usd: calls.reduce((sum, call) => sum + call.costUsd, 0),
      lineup_source: lineupSource,
      proposers_requested: requestedProposers,
      proposers_used: usable.map((item) => item.model),
      aggregator_requested: requestedAggregator,
      aggregator_used: aggregatorModel,
    },
  };
}

export async function embedResearch(text: string): Promise<{
  embedding: number[];
  telemetry: Pick<ModelTelemetry, "provider" | "model" | "latency_ms" | "cost_usd">;
}> {
  const client = await modelClient();
  const result = await client.embeddings(text);
  if (result.error || !result.embedding.length) {
    throw new Error(result.error || "embedding provider returned an empty vector");
  }
  return {
    embedding: result.embedding,
    telemetry: {
      provider: result.provider,
      model: result.model,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
    },
  };
}

export function parseModelJson<T>(content: string): T {
  const stripped = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {}
  const objectStart = stripped.indexOf("{");
  const arrayStart = stripped.indexOf("[");
  const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) throw new Error("model output did not contain JSON");
  const open = stripped[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const char = stripped[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return JSON.parse(stripped.slice(start, i + 1)) as T;
  }
  throw new Error("model output contained incomplete JSON");
}

export async function generateResearchJson<T>(
  prompt: string,
  options: { system?: string; temperature?: number; maxTokens?: number } = {},
): Promise<{ value: T; telemetry: ModelTelemetry }> {
  const generated = await generateResearch(prompt, { ...options, json: true });
  return { value: parseModelJson<T>(generated.content), telemetry: generated.telemetry };
}

export function authorModel(telemetry: ModelTelemetry): string {
  return telemetry.aggregator_used || telemetry.model;
}

export function buildEvidenceManifest(sources: EvidenceSource[], claims: EvidenceClaim[]): string {
  const citedIds = new Set(claims.flatMap((claim) => claim.sourceIds));
  const cited = sources.filter((source) => citedIds.has(source.id));
  const selected = cited.length ? cited : sources.slice(0, 12);
  const omitted = sources.length - selected.length;
  const manifest = selected
    .map((source) => `[${source.id}] (${source.type}) ${source.title}\nURL: ${source.url}\n${source.text}`)
    .join("\n\n");
  return omitted > 0 ? `${manifest}\n\n[${omitted} uncited sources omitted from quality review]` : manifest;
}

export function parseConsensusOutput(stdout: string): GateDecision {
  const marker = "__CG_JSON__";
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error("Consensus Gate output did not include __CG_JSON__");
  const raw = JSON.parse(line.slice(marker.length)) as Record<string, any>;
  const status = raw.status;
  if (status !== "passed" && status !== "rejected" && status !== "escalate") {
    throw new Error(`Consensus Gate returned unknown status: ${String(status)}`);
  }
  const objections = [
    ...(typeof raw.escalate_reason === "string" ? [raw.escalate_reason] : []),
    ...((Array.isArray(raw.verdicts) ? raw.verdicts : []).flatMap((verdict: any) => [
      ...(Array.isArray(verdict.issues) ? verdict.issues : []),
      ...(Array.isArray(verdict.dissent_claims) ? verdict.dissent_claims : []),
    ])),
  ].map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const preferred = record.claim || record.issue || record.message || record.detail || record.text;
      return typeof preferred === "string" ? preferred.trim() : JSON.stringify(record);
    }
    return String(item).trim();
  }).filter(Boolean);
  return {
    consensus_id: String(raw.id || ""),
    status,
    pass: status === "passed" && raw.consensus?.pass === true,
    confidence: Number(raw.consensus?.confidence || 0),
    objections: [...new Set(objections)],
    lineup_source: typeof raw.lineup_source === "string" ? raw.lineup_source : undefined,
    panel_fingerprint: typeof raw.panel_fingerprint === "string" ? raw.panel_fingerprint : undefined,
    excluded_author: typeof raw.excluded_author === "string" ? raw.excluded_author : undefined,
    raw,
  };
}

export function runResearchConsensus(options: {
  input: unknown;
  inputFile: string;
  label: string;
  author: string;
  criteria: string;
}): GateDecision {
  writeFileSync(options.inputFile, JSON.stringify(options.input, null, 2));
  const result = spawnSync("bun", [
    CONSENSUS_GATE,
    "validate",
    "--file", options.inputFile,
    "--criteria", options.criteria,
    "--label", options.label,
    "--mode", "judge",
    "--author", options.author,
    "--json",
  ], {
    encoding: "utf8",
    env: { ...process.env, CG_CALL_TIMEOUT_MS: String(researchConsensusTimeoutMs()) },
    timeout: 12 * 60_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Consensus Gate exited ${result.status}: ${(result.stderr || result.stdout).slice(-1000)}`);
  }
  return parseConsensusOutput(result.stdout);
}

export function buildRepairPrompt(options: {
  query: string;
  draft: string;
  sourceManifest: string;
  gate: GateDecision;
  localObjections?: string[];
}): string {
  const objections = [...new Set([...options.gate.objections, ...(options.localObjections || [])])];
  const objectionBlock = objections.length
    ? objections.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. The quality gate did not pass; re-check every claim against the supplied sources.";
  return `Revise the research draft so it resolves every objection without adding unsupported claims.\n\n` +
    `Research question: ${options.query}\n\nQUALITY-GATE OBJECTIONS:\n${objectionBlock}\n\n` +
    `Rules:\n- Preserve the required Markdown structure.\n- Cite every non-trivial claim with existing [S#] ids.\n` +
    `- Never invent a source id, URL, fact, or quotation.\n- Remove claims the supplied evidence cannot support.\n` +
    `- Address source conflicts and uncertainty explicitly.\n\nSOURCE MANIFEST:\n${options.sourceManifest}\n\n` +
    `DRAFT TO REVISE:\n${options.draft}`;
}
