#!/usr/bin/env bun
// deep-research conductor — chains Consensus (lit), web_research (web), and the internal
// Qdrant corpus into one provenance-tracked synthesis. Self-contained, fail-loud, resumable.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  authorModel,
  buildEvidenceManifest,
  buildRepairPrompt,
  embedResearch,
  generateResearch,
  generateResearchJson,
  researchConsensusTimeoutMs,
  runResearchConsensus,
  type GateDecision,
  type ModelTelemetry,
} from "./research-models";

// ---------- credential self-heal (env -i landmine: OPENAI_API_KEY lives in /root/.zo_secrets) ----------
function selfHeal() {
  if (process.env.OPENAI_API_KEY && process.env.QDRANT_URL) return;
  try {
    const raw = readFileSync("/root/.zo_secrets", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*export\s+([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no secrets file — rely on env */ }
}
selfHeal();

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const ZO_TOKEN = process.env.ZO_CLIENT_IDENTITY_TOKEN || "";
const ZO_API_KEY = process.env.ZO_API_KEY || "";

// Targeted secret lookup: selfHeal short-circuits when OPENAI+QDRANT are already in env (interactive
// path), so a key like ELEVENLABS_API_KEY may not be loaded. Read it directly when needed.
function secretValue(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    for (const line of readFileSync("/root/.zo_secrets", "utf8").split("\n")) {
      const m = line.match(/^\s*export\s+([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no secrets file */ }
  return "";
}
function fileSize(p: string): number { try { return statSync(p).size; } catch { return 0; } }

// ---------- args ----------
const argv = process.argv.slice(2);
const query = argv.find((a) => !a.startsWith("--"));
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}
function bool(name: string): boolean { return argv.includes(`--${name}`); }

if (!query) {
  console.error('Usage: bun research.ts "<research question>" [--collections a,b] [--no-external] [--no-internal] [--force] [--run-dir P] [--max-papers N] [--max-web N] [--audio] [--audio-minutes N] [--audio-tts auto|elevenlabs|openai]');
  process.exit(2);
}

const DO_EXTERNAL = !bool("no-external");
const DO_INTERNAL = !bool("no-internal");
const FORCE = bool("force");
const COLLECTIONS = (flag("collections") || "code-docs,hermes-docs,shared-memory-facts,zouroboros-research").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_PAPERS = parseInt(flag("max-papers") || "6", 10);
const MAX_WEB = parseInt(flag("max-web") || "6", 10);
// v2 surfaces (all auto-skip when their data source is absent)
const DO_COMPOUND = !bool("no-compound");                                  // upsert this run's external sources into a persistent corpus
const CORPUS_COLLECTION = flag("corpus-collection") || "deep-research-corpus"; // run-scoped compounding Qdrant collection
const RAPTOR_COLLECTION = flag("raptor-collection") || "zouroboros-research";  // collection holding RAPTOR L1/L2 summary nodes
const SHARED_FACTS_DB = "/home/workspace/.zo/memory/shared-facts.db";      // GraphRAG community summaries live here
// audio overview (opt-in): NotebookLM-style two-host "deep dive" MP3, generated WITHOUT Google NotebookLM
// (dead cookie auth). Script via the governed research model; ElevenLabs voices with OpenAI TTS fallback.
const DO_AUDIO = bool("audio");
const AUDIO_MINUTES = parseInt(flag("audio-minutes") || "9", 10);
const AUDIO_TTS = (flag("audio-tts") || "auto").toLowerCase();             // auto | elevenlabs | openai
const ELEVENLABS_TTS_MODEL = process.env.DEEP_RESEARCH_ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const OPENAI_TTS_MODEL = process.env.DEEP_RESEARCH_OPENAI_TTS_MODEL || "tts-1";
const [AUDIO_HOST_VOICE, AUDIO_GUEST_VOICE] = (flag("audio-voices") ||
  "21m00Tcm4TlvDq8ikWAM,pNInz6obpgDQGcFmaJgB").split(",").map((s) => s.trim()); // ElevenLabs Rachel(host)/Adam(guest)

const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "research";
const dateStr = new Date().toISOString().slice(0, 10);
const RUN_DIR = flag("run-dir") || join("/home/workspace/Reports/deep-research", `${slug}-${dateStr}`);
mkdirSync(RUN_DIR, { recursive: true });

// ---------- artifact helpers (resumability) ----------
function artPath(name: string): string { return join(RUN_DIR, name); }
function hasArt(name: string): boolean { return !FORCE && existsSync(artPath(name)); }
function readArt<T>(name: string): T { return JSON.parse(readFileSync(artPath(name), "utf8")) as T; }
function writeArt(name: string, data: unknown) {
  writeFileSync(artPath(name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
function fail(stage: string, msg: string): never {
  writeArt("run-status.json", { status: "failed", stage, message: msg, updated_at: new Date().toISOString() });
  console.error(`\n[deep-research] STAGE FAILED: ${stage} — ${msg}`);
  console.error(`[deep-research] Partial artifacts preserved in ${RUN_DIR}`);
  process.exit(1);
}
function log(s: string) { console.log(`[deep-research] ${s}`); }

// ---------- Qdrant + util helpers ----------
function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}
async function qReq(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${QDRANT_URL}${path}`, { method, headers: qHeaders(), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Qdrant ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json().catch(() => ({}));
}
async function qExists(collection: string): Promise<boolean> {
  try { return (await fetch(`${QDRANT_URL}/collections/${collection}`, { headers: qHeaders() })).ok; } catch { return false; }
}
// deterministic UUID5 (RFC 4122) over the default URL namespace — idempotent Qdrant point ids
function uuid5(name: string): string {
  const ns = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"); // URL namespace
  const h = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- /zo/ask self-dispatch with file-sentinel ----------
// The gather/claim-check stages need agent-level MCP tools (Consensus, web research) that a plain
// CLI process cannot call. We self-dispatch to this same Zo via /zo/ask (Bearer ZO_API_KEY): the
// child agent loads those deferred tools via ToolSearch, runs the search, and writes results to a
// file on OUR OWN filesystem (same Zo) — which we then read directly, no transfer needed.
// Why a file and not the HTTP `output`: long tool-using turns frequently return empty synchronous
// output, and `model_name` in the payload reliably breaks output entirely (so we never send it).
async function zoDispatch(input: string): Promise<void> {
  const auth = ZO_API_KEY ? `Bearer ${ZO_API_KEY}` : ZO_TOKEN;
  if (!auth) throw new Error("no ZO_API_KEY or ZO_CLIENT_IDENTITY_TOKEN for /zo/ask");
  const retryable = new Set([429, 500, 502, 503, 504, 529]);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch("https://api.zo.computer/zo/ask", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ input }),
        signal: ctrl.signal,
      });
      if (r.ok) {
        await r.json().catch(() => ({}));
        return;
      }
      const message = `/zo/ask ${r.status}: ${(await r.text()).slice(0, 200)}`;
      if (!retryable.has(r.status)) {
        const error = new Error(message) as Error & { retryable?: boolean };
        error.retryable = false;
        throw error;
      }
      if (attempt >= 3) throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      if ((error as Error & { retryable?: boolean }).retryable === false || attempt >= 3) throw error;
    } finally {
      clearTimeout(t);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}

// Dispatch a research task whose result the child must write (as JSON) to `outFile`, then poll
// for that file. Returns the parsed JSON (array or object), or throws on timeout.
async function zoGatherToFile(task: string, outFile: string, deadlineMs = 290_000): Promise<any> {
  const instruction =
    `${task}\n\n` +
    `OUTPUT PROTOCOL (follow exactly):\n` +
    `- The research tools (mcp__consensus__search, web research/search) are in your deferred-tools ` +
    `list — load them with ToolSearch before calling.\n` +
    `- Write your result as JSON to this file: ${outFile} ` +
    `(run \`mkdir -p $(dirname ${outFile})\` first). If nothing is found, write [].\n` +
    `- After the file is written, reply with ONLY the word DONE.`;
  const start = Date.now();
  await zoDispatch(instruction); // HTTP error propagates; channel wrapper turns it into []
  while (Date.now() - start < deadlineMs) {
    if (existsSync(outFile)) {
      try { return JSON.parse(readFileSync(outFile, "utf8")); } catch { /* still being written */ }
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`gather timeout: ${outFile} never appeared`);
}

// ---------- types ----------
interface Plan { query: string; subQuestions: string[]; domain: string }
interface Source { id: string; type: "consensus" | "web" | "internal" | "corpus"; title: string; url: string; text: string; score: number; subQ: string }
interface ResearchClaim { text: string; sourceIds: string[] }
interface ResearchDraft { md: string; claims: ResearchClaim[]; telemetry: ModelTelemetry; attempt: 0 | 1 }

// ================= STAGE: plan =================
async function stagePlan(): Promise<Plan> {
  if (hasArt("00-plan.json")) { log("plan: cached"); return readArt<Plan>("00-plan.json"); }
  log("plan: decomposing query");
  const { value: parsed } = await generateResearchJson<{ subQuestions: string[]; domain?: string }>(
    `Decompose this research question into 3-5 focused sub-questions that together give comprehensive coverage. ` +
    `Also classify the domain. Return JSON: {"subQuestions": ["..."], "domain": "scientific|technical|general"}.\n\nQuestion: ${query}`,
    { system: "You are a research planner. Output only valid JSON.", maxTokens: 1200 },
  );
  if (!parsed?.subQuestions?.length) fail("plan", "LLM did not return sub-questions");
  const plan: Plan = { query: query!, subQuestions: parsed.subQuestions.slice(0, 5), domain: parsed.domain || "general" };
  writeArt("00-plan.json", plan);
  log(`plan: ${plan.subQuestions.length} sub-questions, domain=${plan.domain}`);
  return plan;
}

// ================= STAGE: gather =================
async function gatherConsensus(subQ: string, idx: number): Promise<Source[]> {
  const outFile = join(RUN_DIR, "_gather", `consensus-${idx}.json`);
  const task =
    `Use the Consensus academic search tool (mcp__consensus__search) to find up to ${MAX_PAPERS} ` +
    `peer-reviewed papers on this question:\n"${subQ}"\n` +
    `The result must be a JSON array of objects: {"title","authors","year","url","abstract","citations"}. ` +
    `Use the exact paper URLs returned by the tool.`;
  const arr = await zoGatherToFile(task, outFile);
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_PAPERS).map((p: any, i: number) => ({
    id: "", type: "consensus" as const,
    title: String(p.title || "Untitled").slice(0, 300),
    url: String(p.url || ""),
    text: `${p.abstract || ""}`.slice(0, 1500) + (p.authors ? ` (${p.authors}, ${p.year || "n.d."}${p.citations ? `, ${p.citations} citations` : ""})` : ""),
    score: 1 - i * 0.05, subQ,
  }));
}

async function gatherWeb(subQ: string, idx: number): Promise<Source[]> {
  const outFile = join(RUN_DIR, "_gather", `web-${idx}.json`);
  const task =
    `Use your web research capability (mcp__zo__web_research, or web search) to investigate this ` +
    `question and return up to ${MAX_WEB} high-quality, non-academic web sources:\n"${subQ}"\n` +
    `The result must be a JSON array of objects: {"title","url","snippet"}.`;
  const arr = await zoGatherToFile(task, outFile);
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_WEB).map((p: any, i: number) => ({
    id: "", type: "web" as const,
    title: String(p.title || "Untitled").slice(0, 300),
    url: String(p.url || ""),
    text: `${p.snippet || ""}`.slice(0, 1000),
    score: 0.9 - i * 0.05, subQ,
  }));
}

async function qdrantVectorConfig(collection: string): Promise<{ named: boolean; name?: string }> {
  const r = await fetch(`${QDRANT_URL}/collections/${collection}`, { headers: QDRANT_KEY ? { "api-key": QDRANT_KEY } : {} });
  if (!r.ok) throw new Error(`qdrant collection ${collection}: ${r.status}`);
  const j: any = await r.json();
  const vectors = j.result?.config?.params?.vectors;
  if (vectors && typeof vectors.size === "number") return { named: false };
  if (vectors && typeof vectors === "object") {
    const preferred = vectors.dense ? "dense" : Object.keys(vectors)[0];
    return { named: true, name: preferred };
  }
  return { named: false };
}

// Embed every sub-question once and share the vectors across all internal channels (cost discipline).
async function embedSubQs(plan: Plan): Promise<Map<string, number[]>> {
  const m = new Map<string, number[]>();
  for (const sq of plan.subQuestions) {
    try { m.set(sq, (await embedResearch(sq)).embedding); } catch (e) { log(`embed failed (${e}) — internal channels degraded`); break; }
  }
  return m;
}

async function gatherInternal(plan: Plan, vecs: Map<string, number[]>): Promise<Source[]> {
  const out: Source[] = [];
  for (const subQ of plan.subQuestions) {
    const vec = vecs.get(subQ);
    if (!vec) continue;
    for (const c of COLLECTIONS) {
      try {
        const cfg = await qdrantVectorConfig(c);
        const body: any = { limit: 4, with_payload: true, vector: cfg.named ? { name: cfg.name, vector: vec } : vec };
        const j = await qReq("POST", `/collections/${c}/points/search`, body);
        for (const pt of j.result || []) {
          const pl = pt.payload || {};
          if (pl.level >= 1) continue; // skip RAPTOR summary nodes here — gatherRaptor owns those
          const content = pl.content || pl.text || pl.value || pl.summary || "";
          if (!content) continue;
          out.push({
            id: "", type: "internal",
            title: `${c}: ${(pl.title || pl.entity || pl.key || "fact").toString().slice(0, 120)}`,
            url: `qdrant://${c}/${pt.id}`,
            text: String(content).slice(0, 1200),
            score: pt.score || 0.5, subQ,
          });
        }
      } catch { /* collection missing/unreachable — skip */ }
    }
  }
  return out;
}

// RAPTOR query-time traversal: retrieve the best-matching L>=1 cluster/corpus summary nodes so the
// synthesis gets hierarchical, broad-coverage context alongside the leaf chunks from gatherInternal.
async function gatherRaptor(plan: Plan, vecs: Map<string, number[]>): Promise<Source[]> {
  if (!(await qExists(RAPTOR_COLLECTION))) return [];
  let cfg: { named: boolean; name?: string };
  try { cfg = await qdrantVectorConfig(RAPTOR_COLLECTION); } catch { return []; }
  const out: Source[] = [];
  for (const subQ of plan.subQuestions) {
    const vec = vecs.get(subQ);
    if (!vec) continue;
    try {
      const j = await qReq("POST", `/collections/${RAPTOR_COLLECTION}/points/search`, {
        limit: 2, with_payload: true,
        vector: cfg.named ? { name: cfg.name, vector: vec } : vec,
        filter: { must: [{ key: "level", range: { gte: 1 } }] },
      });
      for (const pt of j.result || []) {
        const pl = pt.payload || {};
        const content = pl.summary || pl.content || pl.text || "";
        if (!content) continue;
        out.push({
          id: "", type: "internal",
          title: `RAPTOR ${pl.kind || "summary"} (L${pl.level ?? "?"}${pl.cluster_id !== undefined ? ` · cluster ${pl.cluster_id}` : ""})`,
          url: `qdrant://${RAPTOR_COLLECTION}/${pt.id}`,
          text: String(content).slice(0, 1500),
          score: pt.score || 0.5, subQ,
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

// GraphRAG community summaries (Louvain) live in shared-facts.db, not Qdrant — embed each once and
// rank against each sub-question to surface cross-cutting internal-knowledge clusters.
async function gatherCommunities(plan: Plan, vecs: Map<string, number[]>): Promise<Source[]> {
  if (!existsSync(SHARED_FACTS_DB)) return [];
  let rows: { id: string; value: string }[];
  try {
    const db = new Database(SHARED_FACTS_DB, { readonly: true });
    rows = db.query("SELECT id, value FROM facts WHERE entity = 'community.summary'").all() as any[];
    db.close();
  } catch { return []; }
  rows = rows.filter((r) => r.value).slice(0, 50);
  if (!rows.length) return [];
  const embedded: { id: string; value: string; vec: number[] }[] = [];
  for (const r of rows) {
    try { embedded.push({ ...r, vec: (await embedResearch(r.value.slice(0, 2000))).embedding }); } catch { break; }
  }
  const out: Source[] = [];
  for (const subQ of plan.subQuestions) {
    const qv = vecs.get(subQ);
    if (!qv) continue;
    const ranked = embedded.map((s) => ({ s, score: cosine(qv, s.vec) })).sort((a, b) => b.score - a.score).slice(0, 2);
    for (const { s, score } of ranked) {
      if (score < 0.2) continue;
      out.push({
        id: "", type: "internal",
        title: `GraphRAG community ${s.id}`,
        url: `graphrag://${s.id}`,
        text: String(s.value).slice(0, 1200),
        score, subQ,
      });
    }
  }
  return out;
}

// Prior-run compounding corpus: retrieve external sources we durably stored on past runs.
async function gatherCorpus(plan: Plan, vecs: Map<string, number[]>): Promise<Source[]> {
  if (!(await qExists(CORPUS_COLLECTION))) return [];
  const out: Source[] = [];
  for (const subQ of plan.subQuestions) {
    const vec = vecs.get(subQ);
    if (!vec) continue;
    try {
      const j = await qReq("POST", `/collections/${CORPUS_COLLECTION}/points/search`, { vector: vec, limit: 3, with_payload: true });
      for (const pt of j.result || []) {
        const pl = pt.payload || {};
        const content = pl.content || pl.text || "";
        if (!content) continue;
        out.push({
          id: "", type: "corpus",
          title: `prior research [${pl.type || "src"}]: ${(pl.title || "source").toString().slice(0, 110)}`,
          url: String(pl.url || `qdrant://${CORPUS_COLLECTION}/${pt.id}`),
          text: String(content).slice(0, 1000) + (pl.query ? ` (from run: "${String(pl.query).slice(0, 80)}")` : ""),
          score: pt.score || 0.5, subQ,
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

async function stageGather(plan: Plan): Promise<Source[]> {
  if (hasArt("01-gather.json")) { log("gather: cached"); return readArt<{ sources: Source[] }>("01-gather.json").sources; }
  log(`gather: external=${DO_EXTERNAL} internal=${DO_INTERNAL}`);
  const tasks: Promise<Source[]>[] = [];
  if (DO_EXTERNAL) {
    const externalTasks: Array<() => Promise<Source[]>> = [];
    plan.subQuestions.forEach((sq, i) => {
      externalTasks.push(() => gatherConsensus(sq, i).catch((e) => { log(`consensus gather failed for "${sq.slice(0, 40)}": ${e}`); return []; }));
      externalTasks.push(() => gatherWeb(sq, i).catch((e) => { log(`web gather failed for "${sq.slice(0, 40)}": ${e}`); return []; }));
    });
    tasks.push(runBounded(externalTasks, 4).then((chunks) => chunks.flat()));
  }
  if (DO_INTERNAL) {
    const subQVecs = await embedSubQs(plan); // embed each sub-question once, share across all internal channels
    tasks.push(gatherInternal(plan, subQVecs).catch((e) => { log(`internal gather failed: ${e}`); return []; }));
    tasks.push(gatherRaptor(plan, subQVecs).catch((e) => { log(`raptor gather failed: ${e}`); return []; }));
    tasks.push(gatherCommunities(plan, subQVecs).catch((e) => { log(`community gather failed: ${e}`); return []; }));
    tasks.push(gatherCorpus(plan, subQVecs).catch((e) => { log(`corpus gather failed: ${e}`); return []; }));
  }

  const results = await Promise.all(tasks);
  let sources = results.flat();

  // dedupe by normalized url|title
  const seen = new Set<string>();
  sources = sources.filter((s) => {
    const k = (s.url || s.title).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  if (sources.length === 0) fail("gather", "no sources from any channel (Consensus/web/internal all empty)");

  sources.forEach((s, i) => (s.id = `S${i + 1}`));
  const byType = sources.reduce((a: Record<string, number>, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {});
  log(`gather: ${sources.length} sources (${JSON.stringify(byType)})`);
  writeArt("01-gather.json", { sources });
  return sources;
}

async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ================= STAGE: fuse =================
function stageFuse(sources: Source[], plan: Plan): Source[] {
  if (hasArt("02-fused.json")) { log("fuse: cached"); return readArt<{ sources: Source[] }>("02-fused.json").sources; }
  // rank within each subQ by score; keep order stable, preserve ids assigned at gather
  const fused = [...sources].sort((a, b) => {
    if (a.subQ !== b.subQ) return plan.subQuestions.indexOf(a.subQ) - plan.subQuestions.indexOf(b.subQ);
    return b.score - a.score;
  });
  writeArt("02-fused.json", { sources: fused });
  log(`fuse: ${fused.length} ranked sources`);
  return fused;
}

function normalizeCitations(markdown: string): string {
  return markdown.replace(/【S(\d+)】/g, "[S$1]");
}

function extractClaims(markdown: string, sources: Source[]): ResearchClaim[] {
  const validIds = new Set(sources.map((source) => source.id));
  const claims: ResearchClaim[] = [];
  for (const line of markdown.split("\n")) {
    const sourceIds = [...line.matchAll(/\[S(\d+)\]/g)]
      .map((match) => `S${match[1]}`)
      .filter((id) => validIds.has(id));
    if (sourceIds.length) {
      claims.push({ text: line.replace(/^[-*#\s]+/, "").trim(), sourceIds: [...new Set(sourceIds)] });
    }
  }
  return claims;
}

function sourceManifest(sources: Source[], draft: ResearchDraft): string {
  return buildEvidenceManifest(sources, draft.claims);
}

// ================= STAGE: synthesize =================
async function stageSynthesize(sources: Source[], plan: Plan): Promise<ResearchDraft> {
  if (hasArt("03-synthesis.md") && hasArt("03-claims.json") && hasArt("03-generation.json")) {
    log("synthesize: cached");
    return {
      md: readFileSync(artPath("03-synthesis.md"), "utf8"),
      claims: readArt("03-claims.json"),
      telemetry: readArt("03-generation.json"),
      attempt: 0,
    };
  }
  log("synthesize: generating analytical synthesis");
  const srcBlock = sources.map((s) => `[${s.id}] (${s.type}) ${s.title}\n${s.text}`).join("\n\n");
  const subqList = plan.subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const prompt =
    `Research question: ${plan.query}\n\nSub-questions:\n${subqList}\n\nSOURCES:\n${srcBlock}\n\n` +
    `Write a neutral, analytical research synthesis in Markdown. Structure:\n` +
    `## Executive Summary (3-5 bullets)\n## Findings (one ### subsection per sub-question)\n## Gaps & Open Questions\n\n` +
    `Rules:\n- Cite every non-trivial claim inline with [S#] markers matching the source ids above.\n` +
    `- Only cite ids that exist. Never invent sources or ids.\n- Where sources conflict, say so.\n` +
    `- Analytical tone, no fluff, no first person.`;
  const generated = await generateResearch(prompt, {
    temperature: 0.3,
    maxTokens: 8192,
    system: "You are a rigorous research analyst. Cite sources with [S#] markers.",
  });
  const md = normalizeCitations(generated.content);
  if (!md.trim()) fail("synthesize", "empty synthesis from LLM");
  const claims = extractClaims(md, sources);
  writeArt("03-synthesis.md", md);
  writeArt("03-claims.json", claims);
  writeArt("03-generation.json", generated.telemetry);
  log(`synthesize: ${claims.length} cited claims`);
  return { md, claims, telemetry: generated.telemetry, attempt: 0 };
}

function stageQualityGate(draft: ResearchDraft, sources: Source[], plan: Plan): GateDecision {
  const manifest = sourceManifest(sources, draft);
  const citationIds = [...new Set(draft.claims.flatMap((claim) => claim.sourceIds))];
  const gateInput = {
    query: plan.query,
    draft: draft.md,
    claim_count: draft.claims.length,
    citation_ids: citationIds,
    sources: manifest,
    review_timeout_ms: researchConsensusTimeoutMs(),
  };
  const inputSha256 = createHash("sha256").update(JSON.stringify(gateInput)).digest("hex");
  const artifact = `04-consensus-attempt-${draft.attempt}.json`;
  if (hasArt(artifact)) {
    const cached = readArt<GateDecision>(artifact);
    if (cached.input_sha256 === inputSha256) {
      log(`quality-gate: cached attempt ${draft.attempt}`);
      return cached;
    }
  }
  log(`quality-gate: evaluating attempt ${draft.attempt}`);
  const gate = runResearchConsensus({
    input: gateInput,
    inputFile: artPath(`04-consensus-attempt-${draft.attempt}-input.json`),
    label: `deep-research-${slug}-attempt-${draft.attempt}`,
    author: authorModel(draft.telemetry),
    criteria: "Pass only when the draft answers the research question, every material claim is supported by an existing source id, citations resolve to the supplied manifest, uncertainty and conflicting evidence are explicit, and no unsupported facts or URLs appear.",
  });
  gate.input_sha256 = inputSha256;
  writeArt(artifact, gate);
  return gate;
}

async function stageRepair(draft: ResearchDraft, gate: GateDecision, sources: Source[], plan: Plan): Promise<ResearchDraft> {
  const manifest = sourceManifest(sources, draft);
  const inputSha256 = createHash("sha256").update(JSON.stringify({
    query: plan.query,
    draft: draft.md,
    gate_status: gate.status,
    gate_objections: gate.objections,
    sources: manifest,
  })).digest("hex");
  if (hasArt("03-synthesis-repair.md") && hasArt("03-claims-repair.json") && hasArt("03-generation-repair.json")) {
    const cachedGeneration = readArt<ModelTelemetry & { input_sha256?: string }>("03-generation-repair.json");
    if (cachedGeneration.input_sha256 === inputSha256) {
      log("repair: cached");
      return {
        md: readFileSync(artPath("03-synthesis-repair.md"), "utf8"),
        claims: readArt("03-claims-repair.json"),
        telemetry: cachedGeneration,
        attempt: 1,
      };
    }
    log("repair: gate input changed; regenerating");
  }
  log("repair: applying quality-gate objections");
  const repaired = await generateResearch(buildRepairPrompt({
    query: plan.query,
    draft: draft.md,
    sourceManifest: manifest,
    gate,
  }), {
    temperature: 0.2,
    maxTokens: 8192,
    system: "You are a rigorous research editor. Return only the repaired Markdown report body.",
  });
  const md = normalizeCitations(repaired.content);
  const claims = extractClaims(md, sources);
  writeArt("03-synthesis-repair.md", md);
  writeArt("03-claims-repair.json", claims);
  const telemetry = { ...repaired.telemetry, input_sha256: inputSha256 };
  writeArt("03-generation-repair.json", telemetry);
  return { md, claims, telemetry, attempt: 1 };
}

// ================= STAGE: claim-check (best-effort) =================
async function stageClaimCheck(draft: ResearchDraft, plan: Plan): Promise<any> {
  const inputSha256 = createHash("sha256").update(JSON.stringify({ query: plan.query, claims: draft.claims })).digest("hex");
  if (hasArt("04-validated.json")) {
    const cached = readArt<any>("04-validated.json");
    if (cached.input_sha256 === inputSha256) { log("claim-check: cached"); return cached; }
    log("claim-check: claim input changed; rerunning");
  }
  if (!DO_EXTERNAL || plan.domain === "general") {
    const skip = { checked: false, reason: DO_EXTERNAL ? "non-scientific domain" : "external disabled", results: [], input_sha256: inputSha256 };
    writeArt("04-validated.json", skip); log("claim-check: skipped"); return skip;
  }
  log("claim-check: verifying top claims against literature (best-effort, free-tier 3-result cap)");
  const top = draft.claims.slice(0, 3);
  const results: any[] = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const outFile = join(RUN_DIR, "_check", `claim-${i}.json`);
    try {
      const j = await zoGatherToFile(
        `Using the Consensus academic search tool (mcp__consensus__search) if available, else web research, ` +
        `assess whether peer-reviewed evidence supports this claim:\n"${c.text}"\n` +
        `The result must be a JSON object: {"verdict":"supported|mixed|unsupported|insufficient","note":"one sentence"}.`,
        outFile, 200_000,
      );
      results.push({ claim: c.text, verdict: j?.verdict || "insufficient", note: j?.note || "no parseable response" });
    } catch (e) { results.push({ claim: c.text, verdict: "insufficient", note: `check failed: ${e}` }); }
  }
  const out = { checked: true, results, input_sha256: inputSha256 };
  writeArt("04-validated.json", out);
  log(`claim-check: ${results.length} claims checked`);
  return out;
}

// ================= STAGE: report =================
function stageReport(plan: Plan, sources: Source[], synthMd: string, validation: any): string {
  const lines: string[] = [];
  lines.push(`# Deep Research: ${plan.query}`, "");
  lines.push(`*Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · domain: ${plan.domain} · ${sources.length} sources*`, "");
  lines.push(synthMd.trim(), "");

  if (validation?.checked && validation.results?.length) {
    lines.push("## Claim Validation", "");
    lines.push("Best-effort literature check on key claims (Consensus free tier caps at 3 results/search):", "");
    for (const r of validation.results) lines.push(`- **${r.verdict}** — ${r.claim}\n  - ${r.note}`);
    lines.push("");
  }

  lines.push("## Sources", "");
  const grouped: Record<string, Source[]> = { consensus: [], web: [], internal: [], corpus: [] };
  for (const s of sources) (grouped[s.type] ||= []).push(s);
  const labels: Record<string, string> = { consensus: "Peer-reviewed literature", web: "Web", internal: "Internal corpus (Qdrant)", corpus: "Prior research (compounding corpus)" };
  for (const type of ["consensus", "web", "internal", "corpus"]) {
    if (!grouped[type]?.length) continue;
    lines.push(`### ${labels[type]}`, "");
    for (const s of grouped[type]) {
      const link = s.url.startsWith("http") ? `[${s.title}](${s.url})` : `${s.title}`;
      lines.push(`- **[${s.id}]** ${link}`);
    }
    lines.push("");
  }
  lines.push("---", `*Pipeline: deep-research v2 · run dir \`${RUN_DIR}\`*`);
  const report = lines.join("\n");
  writeArt("report.md", report);
  log(`report: written (${report.length} chars)`);
  return report;
}

// ================= STAGE: persist (soft-fail) =================
function stagePersist(plan: Plan, sources: Source[]) {
  const memCli = "/home/workspace/Skills/zo-memory-system/scripts/memory.ts";
  if (!existsSync(memCli)) { log("persist: memory CLI not found — skipping (soft)"); return; }
  try {
    const val = `Deep research run on "${plan.query}" (${plan.domain}): ${sources.length} sources across ${plan.subQuestions.length} sub-questions. Report: ${artPath("report.md")}`;
    const res = spawnSync("bun", [memCli, "store", "--entity", "deep-research", "--key", slug, "--value", val, "--decay", "stable", "--category", "project"], { encoding: "utf8", timeout: 60_000 });
    if (res.status === 0) log("persist: episode stored to memory");
    else log(`persist: memory store non-zero (soft) — ${(res.stderr || "").slice(0, 120)}`);
  } catch (e) { log(`persist: failed (soft) — ${e}`); }
}

// ================= STAGE: compound (soft-fail) =================
// Durably store this run's external sources (consensus + web) into a persistent Qdrant collection
// so future runs' gatherCorpus channel can surface what we already researched. Idempotent: UUID5
// point ids keyed on the source url|title, re-upserts are no-ops on identical content.
async function ensureCorpus(): Promise<boolean> {
  if (await qExists(CORPUS_COLLECTION)) return true;
  try {
    await qReq("PUT", `/collections/${CORPUS_COLLECTION}`, {
      vectors: { size: 1536, distance: "Cosine" },
      on_disk_payload: true,
    });
    log(`compound: created corpus collection "${CORPUS_COLLECTION}"`);
    return true;
  } catch (e) { log(`compound: could not create corpus (soft) — ${e}`); return false; }
}

async function stageCompound(sources: Source[], plan: Plan) {
  if (!DO_COMPOUND) { log("compound: disabled (--no-compound)"); return; }
  if (hasArt("05-compound.json")) { log("compound: cached"); return; }
  const external = sources.filter((s) => (s.type === "consensus" || s.type === "web") && s.text.trim());
  if (!external.length) { log("compound: no external sources to persist — skipping"); return; }
  try {
    if (!(await ensureCorpus())) return;
    const points: any[] = [];
    for (const s of external) {
      let vec: number[];
      try { vec = (await embedResearch(`${s.title}\n${s.text}`)).embedding; } catch { continue; }
      points.push({
        id: uuid5(`${CORPUS_COLLECTION}:${s.url || s.title}`),
        vector: vec,
        payload: { query: plan.query, subQ: s.subQ, type: s.type, title: s.title, url: s.url, content: s.text, run_date: dateStr, run_slug: slug },
      });
    }
    if (!points.length) { log("compound: embedding produced no points — skipping"); return; }
    await qReq("PUT", `/collections/${CORPUS_COLLECTION}/points?wait=true`, { points });
    writeArt("05-compound.json", { collection: CORPUS_COLLECTION, upserted: points.length, run_date: dateStr });
    log(`compound: upserted ${points.length} external sources into "${CORPUS_COLLECTION}"`);
  } catch (e) { log(`compound: failed (soft) — ${e}`); }
}

// ================= STAGE: audio overview (opt-in) =================
// A durable, Google-NotebookLM-independent replacement for the deferred "NotebookLM audio export"
// item: turn the synthesis into a two-host "deep dive" MP3. Script generation uses the governed
// research model; voices come from ElevenLabs with an automatic OpenAI-TTS fallback.
async function ttsElevenLabs(text: string, voiceId: string, apiKey: string): Promise<Buffer> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_TTS_MODEL,
      voice_settings: { stability: 0.85, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function ttsOpenAI(text: string, voice: string): Promise<Buffer> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice, input: text.slice(0, 4000) }),
  });
  if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function stageAudio(plan: Plan, synthMd: string) {
  if (!DO_AUDIO) return;
  const mp3Path = artPath("report.mp3");
  if (!FORCE && fileSize(mp3Path) > 0) { log("audio: cached (report.mp3 exists)"); return; }
  log("audio: generating NotebookLM-style overview (governed research model + ElevenLabs/OpenAI TTS)");

  // 1. script — reuse the conductor's governed research model
  let lines: { speaker: string; text: string }[];
  if (!FORCE && hasArt("06-podcast.json")) {
    lines = readArt<{ lines: { speaker: string; text: string }[] }>("06-podcast.json").lines;
  } else {
    const cleaned = synthMd.replace(/\[S\d+\]/g, "").replace(/[#*`>_]/g, " ").replace(/\n{2,}/g, "\n").trim();
    const prompt =
      `Turn this research synthesis into a natural two-host audio overview script — the style of a ` +
      `NotebookLM "deep dive" podcast.\n\nTopic: ${plan.query}\n\n` +
      `HOST: warm and curious; frames the topic, asks good questions, summarizes for the listener.\n` +
      `GUEST: the research analyst; explains the findings, the strength of the evidence, and the caveats ` +
      `conversationally.\n\nRules:\n` +
      `- Target ~${AUDIO_MINUTES} minutes (~${AUDIO_MINUTES * 150} words total), 14-26 alternating turns.\n` +
      `- Start with a brief HOST intro; end with a clear takeaway.\n` +
      `- SPOKEN words only: no citation markers, no bracketed codes, no markdown, no bullets, no stage directions.\n` +
      `- Ground every statement in the synthesis below; do not invent facts or numbers.\n\n` +
      `Return JSON: {"lines":[{"speaker":"host"|"guest","text":"..."}]}\n\nSYNTHESIS:\n${cleaned.slice(0, 9000)}`;
    const { value: parsed } = await generateResearchJson<{ lines?: Array<{ speaker: string; text: string }> } | Array<{ speaker: string; text: string }>>(
      prompt,
      { temperature: 0.5, maxTokens: 5000, system: "You are a podcast script writer. Output only valid JSON." },
    );
    const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed.lines) ? parsed.lines : [];
    lines = raw
      .filter((l: any) => l && (l.speaker === "host" || l.speaker === "guest") && String(l.text || "").trim())
      .map((l: any) => ({ speaker: l.speaker, text: String(l.text).trim() }))
      .slice(0, 40);
    if (!lines.length) fail("audio", "script generation produced no usable dialogue lines");
    writeArt("06-podcast.json", { query: plan.query, minutes: AUDIO_MINUTES, turns: lines.length, lines });
  }
  log(`audio: ${lines.length} dialogue turns`);

  // 2. pick TTS backend
  const elKey = secretValue("ELEVENLABS_API_KEY");
  let backend = AUDIO_TTS === "auto" ? (elKey ? "elevenlabs" : OPENAI_KEY ? "openai" : "") : AUDIO_TTS;
  if (backend === "elevenlabs" && !elKey) backend = OPENAI_KEY ? "openai" : "";
  if (!backend || (backend === "openai" && !OPENAI_KEY)) {
    fail("audio", "no TTS backend available (need ELEVENLABS_API_KEY or OPENAI_API_KEY)");
  }
  log(`audio: TTS backend = ${backend}`);

  // 3. synthesize each turn (segment-level idempotency), with mid-run ElevenLabs→OpenAI fallback
  const segDir = join(RUN_DIR, "_audio");
  mkdirSync(segDir, { recursive: true });
  const segPaths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const segPath = join(segDir, `seg-${String(i).padStart(3, "0")}.mp3`);
    if (!FORCE && fileSize(segPath) > 0) { segPaths.push(segPath); continue; }
    try {
      const buf = backend === "elevenlabs"
        ? await ttsElevenLabs(l.text, l.speaker === "host" ? AUDIO_HOST_VOICE : AUDIO_GUEST_VOICE, elKey)
        : await ttsOpenAI(l.text, l.speaker === "host" ? "nova" : "onyx");
      writeFileSync(segPath, buf);
      segPaths.push(segPath);
    } catch (e) {
      if (backend === "elevenlabs" && OPENAI_KEY) {
        log(`audio: ElevenLabs failed (${e}) — switching remaining segments to OpenAI TTS`);
        backend = "openai";
        const buf = await ttsOpenAI(l.text, l.speaker === "host" ? "nova" : "onyx");
        writeFileSync(segPath, buf);
        segPaths.push(segPath);
      } else {
        fail("audio", `TTS failed on segment ${i}: ${e}`);
      }
    }
    process.stdout.write(`\r  synthesized ${i + 1}/${lines.length} segments`);
  }
  process.stdout.write("\n");
  if (!segPaths.length) fail("audio", "no audio segments synthesized");

  // 4. concat (proven: ElevenLabs/OpenAI MP3 segments concat cleanly with -c copy)
  const listFile = join(segDir, "segments.txt");
  writeFileSync(listFile, segPaths.map((p) => `file '${p}'\n`).join(""));
  const ff = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", mp3Path], { encoding: "utf8" });
  if (ff.status !== 0 || fileSize(mp3Path) === 0) fail("audio", `ffmpeg concat failed: ${(ff.stderr || "").slice(-200)}`);
  log(`audio: report.mp3 written (${(fileSize(mp3Path) / 1024 / 1024).toFixed(1)} MB, ${lines.length} turns, ${backend})`);
}

// ================= MAIN =================
(async () => {
  log(`query: "${query}"`);
  log(`run dir: ${RUN_DIR}`);
  writeArt("run-status.json", { status: "running", query, updated_at: new Date().toISOString() });
  const plan = await stagePlan();
  const gathered = await stageGather(plan);
  const fused = stageFuse(gathered, plan);
  let draft = await stageSynthesize(fused, plan);
  let gate = stageQualityGate(draft, fused, plan);
  let repairApplied = false;
  if (gate.status === "rejected") {
    repairApplied = true;
    draft = await stageRepair(draft, gate, fused, plan);
    gate = stageQualityGate(draft, fused, plan);
  }
  if (gate.status !== "passed" || !gate.pass) {
    const phase = repairApplied ? "after one repair" : "before content repair";
    fail("quality-regate", `Consensus Gate ${gate.status} ${phase} (confidence=${gate.confidence.toFixed(3)})`);
  }

  // AC3: every [S#] marker resolves to a known source id
  const valid = new Set(fused.map((s) => s.id));
  const orphans = [...new Set([...draft.md.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`))].filter((id) => !valid.has(id));
  if (orphans.length) log(`WARN: orphan citations not in bibliography: ${orphans.join(", ")}`);

  const validation = await stageClaimCheck(draft, plan);
  stageReport(plan, fused, draft.md, validation);
  stagePersist(plan, fused);
  await stageCompound(fused, plan); // soft-fail: store external sources for future-run reuse
  await stageAudio(plan, draft.md); // opt-in (--audio): Google-NotebookLM-independent audio overview

  const audioNote = DO_AUDIO && fileSize(artPath("report.mp3")) > 0 ? `\nAudio: ${artPath("report.mp3")}` : "";
  writeArt("run-status.json", {
    status: "complete",
    query: plan.query,
    report: artPath("report.md"),
    sources: fused.length,
    cited_claims: draft.claims.length,
    quality_gate: "passed",
    updated_at: new Date().toISOString(),
  });
  console.log(`\n${"=".repeat(60)}\n[deep-research] COMPLETE\nReport: ${artPath("report.md")}${audioNote}\nSources: ${fused.length} | Cited claims: ${draft.claims.length} | Orphans: ${orphans.length} | Quality gate: passed\n${"=".repeat(60)}`);
})().catch((e) => fail("main", String(e?.stack || e)));
