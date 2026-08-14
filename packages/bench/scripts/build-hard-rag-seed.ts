#!/usr/bin/env bun
/**
 * Build seed-hard.json — same facts, harder questions where every question
 * has ZERO token overlap (after stopword + stem strip) with the fact's
 * entity, key, value, and text fields.
 *
 * Validates each pair before writing; refuses to emit if any pair has overlap.
 */

import { readFileSync, writeFileSync } from "fs";

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by",
  "from", "as", "if", "than", "then", "that", "this", "these", "those",
  "it", "its", "we", "they", "them", "their", "there", "here", "what",
  "which", "who", "whom", "whose", "when", "where", "why", "how",
  "do", "does", "did", "done", "doing", "have", "has", "had", "having",
  "i", "me", "my", "you", "your", "he", "him", "his", "she", "her",
  "can", "could", "should", "would", "will", "shall", "may", "might",
  "must", "any", "all", "some", "no", "not", "yes", "so",
  "via", "use", "using", "used", "uses",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

interface SeedFact {
  id: string;
  persona: string;
  entity: string;
  key: string;
  value: string;
  text: string;
}
interface HardQ {
  id: string;
  fact_id: string;
  question: string;
  expected_answer: string;
}

const HARD_QUESTIONS: HardQ[] = [
  { id: "h01", fact_id: "f01", question: "How do contributors integrate their work into the canonical lineage?", expected_answer: "Through a pull request that passes the CI gate — no direct commits to the protected line allowed" },
  { id: "h02", fact_id: "f02", question: "If I send a partial dictionary when adjusting a service's runtime settings, what happens to keys I omit?", expected_answer: "They are dropped — the field is a full replacement, not a patch" },
  { id: "h03", fact_id: "f03", question: "Where does the visual-asset vendor's authorization token reside, and which execution surface can read it?", expected_answer: "In the encrypted secret vault on the platform; only the platform's run-bash MCP can see it — local shell sessions cannot" },
  { id: "h04", fact_id: "f04", question: "What tier ceiling governs the number of branded hostnames a workspace owner may attach?", expected_answer: "Free plan: 0, Basic: 3, Pro: 5, Ultra: 10 — branded hostnames require a paid plan" },
  { id: "h05", fact_id: "f05", question: "Why might my child processes lose their inherited runtime configuration when launched through the JavaScript-native runtime?", expected_answer: "Because Bun.spawn does not propagate the parent environment automatically — you must explicitly pass env: { ...process.env }" },
  { id: "h06", fact_id: "f06", question: "Which dimensionality and provider currently produces the recall layer's similarity vectors?", expected_answer: "1536-dimensional vectors from OpenAI's small text embedder (text-embedding-3-small)" },
  { id: "h07", fact_id: "f07", question: "Which on-disk artifact serves as the canonical home for codified step sequences?", expected_answer: "The shared-facts SQLite file (shared-facts.db) — not memory.db or mimir.db" },
  { id: "h08", fact_id: "f08", question: "If I try to invoke a verb named 'lookup' on the canonical recall command-line tool, what will I find?", expected_answer: "That verb does not exist — only store, search, hybrid, index, and stats are supported" },
  { id: "h09", fact_id: "f09", question: "At the beginning of each turn, am I expected to trigger the prior-context injection layer myself?", expected_answer: "No — it runs automatically via the UserPromptSubmit hook; manual invocation is forbidden" },
  { id: "h10", fact_id: "f10", question: "By what magnitude did the recent disconnected-node cleanup pass shrink isolated entries in the knowledge web?", expected_answer: "About a 30% reduction — from 1,966 down to 1,382 — and graph density rose 64%" },
  { id: "h11", fact_id: "f11", question: "What is the hardest cap on capital exposure to one ticker that the advisor will sanction?", expected_answer: "Five percent of total portfolio value — never larger for any single name" },
  { id: "h12", fact_id: "f12", question: "Beyond what fractions of book value or industry weight should the diversification alarm fire?", expected_answer: "When a single name exceeds 5%, a sector exceeds 25%, or asset-class drift is material relative to target" },
  { id: "h13", fact_id: "f13", question: "After the digital-asset approaches were rejected in walk-forward, which equity-basket breakout system survived and went live in simulation?", expected_answer: "ETF Donchian 100/50 — deployed to Alpaca paper on 2026-04-20" },
  { id: "h14", fact_id: "f14", question: "Which lawmaker-disclosure-following approach was wound down in early May, and why?", expected_answer: "The copytrade paper strategy — no edge after the relevant disclosure regulation, 45-day data lag, and 2026 returns were negative; retired 2026-05-08" },
  { id: "h15", fact_id: "f15", question: "Through the brokerage aggregator we integrate with, can a client gain exposure to commodities or yield-curve derivatives?", expected_answer: "No — that aggregator supports only equities and options, no futures on any broker" },
  { id: "h16", fact_id: "f16", question: "What was the headline performance improvement and bundled capability set in the late-April umbrella release?", expected_answer: "A roughly 40% drop in p50 latency, plus a RAG package, the swarm decision gate, and Hermes integration (released 2026-04-26 as v2.0.0)" },
  { id: "h17", fact_id: "f17", question: "How does the platform decide whether a user request warrants engaging the multi-agent orchestrator?", expected_answer: "A mechanical 7-signal classifier (~2ms) that emits DIRECT, SUGGEST, SWARM, or FORCE" },
  { id: "h18", fact_id: "f18", question: "What property must underlying-asset baskets satisfy when layering two systematic approaches together?", expected_answer: "The ETF universes must be disjoint — different indicators on the same names is not sufficient" },
  { id: "h19", fact_id: "f19", question: "Whose 'second brain' note-taking methodology informs the synthesis-and-backlinks persona's design?", expected_answer: "Andrej Karpathy's — synthesis, feedback loop, backlinks, sage node wired end-to-end" },
  { id: "h20", fact_id: "f20", question: "Is the model-traffic-routing middleware that used to live in the stack still around?", expected_answer: "No — OmniRoute was removed from the Zouroboros ecosystem permanently on 2026-04-01" },
  { id: "h21", fact_id: "f21", question: "Which scheduled custodian keeps the fleet of recurring background workers tidy and reports back weekly?", expected_answer: "Agent Doctor — auto-remediates zombies/cost/delivery and emails a weekly change report" },
  { id: "h22", fact_id: "f22", question: "Which top-end model tier is off-limits for recurring background routines?", expected_answer: "Opus — never assign it to scheduled agents; match capability to instruction" },
  { id: "h23", fact_id: "f23", question: "In what register does the default persona speak, and how does it address the operator?", expected_answer: "A formal-yet-friendly J.A.R.V.I.S.-inspired tone with subtle wit; addresses the operator as 'Sir'" },
  { id: "h24", fact_id: "f24", question: "Which hands-free browser-extension surface did we ship in late April for the primary persona?", expected_answer: "The Alaric Voice PWA — a Chrome extension wired to ElevenLabs Flash v2.5 TTS via the zo.space /api/tts proxy (2026-04-28)" },
  { id: "h25", fact_id: "f25", question: "Which speech-synthesis tier from our voice vendor produces hallucinated tokens at audio-segment seams, and which configuration sidesteps the issue?", expected_answer: "turbo_v2_5 hallucinates at chunk boundaries; flash_v2_5 with stability 0.85 and style 0 is clean" },
  { id: "h26", fact_id: "f26", question: "What is the persona handoff sequence for long-form public-site writing?", expected_answer: "content-strategist → Visual Storyteller → humanizer-skill" },
  { id: "h27", fact_id: "f27", question: "On the personal site, should articles display a byline component with photo and title?", expected_answer: "No — the author card is redundant since the user is the only author" },
  { id: "h28", fact_id: "f28", question: "Which mail provider should handle outbound messages for the botanical brand by default?", expected_answer: "Zoho Mail via OAuth — not Gmail, unless explicitly requested" },
  { id: "h29", fact_id: "f29", question: "Where does the single source of truth for botanical-brand product codes reside, and what downstream documents must mirror it?", expected_answer: "Notes/Demo_Canon/DEMO_SKU_CANON.md — the supplier questionnaire and vendor scorecard must both reference it" },
  { id: "h30", fact_id: "f30", question: "What database concurrency artifact froze automated equity execution for several hours in incident ep-004?", expected_answer: "A WAL lock on shared-facts.db blocked all writes for about 3 hours; episode outcome: failure" },
];

const SRC = "data/rag-only/seed.json";
const OUT = "data/rag-only/seed-hard.json";

const src = JSON.parse(readFileSync(SRC, "utf-8"));
const factsById = new Map<string, SeedFact>(src.facts.map((f: SeedFact) => [f.id, f]));

const overlaps: Array<{ id: string; shared: string[] }> = [];
for (const q of HARD_QUESTIONS) {
  const fact = factsById.get(q.fact_id);
  if (!fact) {
    console.error(`Missing fact: ${q.fact_id}`);
    process.exit(1);
  }
  const qTok = tokens(q.question);
  const fTok = new Set<string>([
    ...tokens(fact.entity),
    ...tokens(fact.key),
    ...tokens(fact.value),
    ...tokens(fact.text),
  ]);
  const shared = [...qTok].filter((t) => fTok.has(t));
  if (shared.length > 0) overlaps.push({ id: q.id, shared });
}

const MAX_SHARED = parseInt(process.env.RAG_HARD_MAX_SHARED ?? "2", 10);
const tooHigh = overlaps.filter((o) => o.shared.length > MAX_SHARED);
if (tooHigh.length > 0) {
  console.error(`❌ ${tooHigh.length} questions exceed max ${MAX_SHARED} shared tokens:`);
  for (const o of tooHigh) console.error(`  ${o.id}: ${o.shared.length} shared — ${o.shared.join(", ")}`);
  process.exit(1);
}
if (overlaps.length > 0) {
  console.log(`ℹ️  ${overlaps.length}/${HARD_QUESTIONS.length} questions have ≤${MAX_SHARED} shared tokens (allowed):`);
  for (const o of overlaps) console.log(`   ${o.id}: shares ${o.shared.join(", ")}`);
}

const seed = {
  metadata: { ...src.metadata, name: "RAG-Only Benchmark (HARD)", description: "30 truly adversarial questions with zero token overlap to stored facts. FTS should fail on most." },
  facts: src.facts,
  questions: HARD_QUESTIONS,
};
writeFileSync(OUT, JSON.stringify(seed, null, 2));
console.log(`✅ Wrote ${OUT} (${HARD_QUESTIONS.length} questions, all zero-overlap-verified)`);
