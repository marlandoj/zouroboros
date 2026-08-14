#!/usr/bin/env bun
/**
 * Generate a 100-Q/A seed by:
 *   1. Keeping the existing 30 hand-crafted facts/questions
 *   2. Sampling 80 facts from shared-facts.db (real production data)
 *   3. Auto-paraphrasing each sampled fact into Q/A via gpt-4o-mini
 *   4. Filtering out questions that share too many tokens with their fact
 *   5. Keeping 70 of the cleanest
 *
 * Writes data/rag-only/seed-100.json.
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const SHARED_DB = "/home/workspace/.zo/memory/shared-facts.db";
const HAND_SEED = "data/rag-only/seed-hard.json";
const OUT = "data/rag-only/seed-100.json";
const SAMPLE_SIZE = 80;
const TARGET_GENERATED = 70;
const MAX_SHARED = 4;
const CONCURRENCY = 8;

const STOP = new Set([
  "the","a","an","is","are","was","were","be","been","being","and","or","but","of","to","in","on","at","for","with","by","from","as","if","than","then","that","this","these","those","it","its","we","they","them","their","there","here","what","which","who","whom","whose","when","where","why","how","do","does","did","done","doing","have","has","had","having","i","me","my","you","your","he","him","his","she","her","can","could","should","would","will","shall","may","might","must","any","all","some","no","not","yes","so","via","use","using","used","uses","one","two","three",
]);

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 2 && !STOP.has(t)));
}

async function chat(prompt: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.6,
          max_tokens: 300,
        }),
      });
      if (res.status >= 500 || res.status === 429) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content?.trim() ?? "";
    } catch {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return "";
}

interface FactRow { id: string; persona: string; entity: string; key: string | null; value: string; text: string | null; }

async function generateQA(fact: FactRow): Promise<{ question: string; expected_answer: string } | null> {
  const factText = `${fact.value}\n${fact.text ?? ""}`;
  const prompt = `You are creating a benchmark question for a retrieval system.

Stored fact:
"""
${factText}
"""

Write a question and a concise expected answer where:
1. The QUESTION uses synonyms and paraphrasing — do NOT reuse the same nouns/verbs as the stored fact when reasonable alternatives exist. The question should require semantic understanding to retrieve the fact.
2. The EXPECTED ANSWER is a single concise sentence that accurately states what the fact says.
3. Avoid yes/no questions when possible — prefer "what/which/how" questions that demand a specific factual answer.

Respond with ONLY a JSON object: {"question": "...", "expected_answer": "..."}. No preamble.`;

  const raw = await chat(prompt);
  if (!raw) return null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m?.[0] ?? raw);
    if (!obj.question || !obj.expected_answer) return null;
    return { question: String(obj.question).trim(), expected_answer: String(obj.expected_answer).trim() };
  } catch {
    return null;
  }
}

async function main() {
  if (!OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

  // Load hand-crafted seed
  const hand = JSON.parse(readFileSync(HAND_SEED, "utf-8"));

  // Sample real facts from shared-facts.db
  console.log(`[1/3] Sampling ${SAMPLE_SIZE} facts from shared-facts.db...`);
  const db = new Database(SHARED_DB, { readonly: true });
  const sampled = db.prepare(`
    SELECT id, persona, entity, COALESCE(key, '') as key, value, COALESCE(text, '') as text
    FROM facts
    WHERE value IS NOT NULL
      AND length(value) BETWEEN 40 AND 400
      AND length(value) <= 400
      AND entity IS NOT NULL
      AND entity != ''
    ORDER BY RANDOM() LIMIT ?
  `).all(SAMPLE_SIZE) as FactRow[];
  db.close();
  console.log(`  Got ${sampled.length} facts.`);

  // Renumber to avoid collisions with f01-f30
  const renumbered = sampled.map((f, i) => ({
    ...f,
    id: `g${(i + 1).toString().padStart(3, "0")}`,
  }));

  // Generate Q/A in batches
  console.log(`[2/3] Generating Q/A pairs (concurrency=${CONCURRENCY})...`);
  const generated: Array<{ fact: FactRow; q: string; a: string }> = [];
  for (let i = 0; i < renumbered.length; i += CONCURRENCY) {
    const batch = renumbered.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(generateQA));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r) generated.push({ fact: batch[j], q: r.question, a: r.expected_answer });
    }
    process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, renumbered.length)}/${renumbered.length} processed, ${generated.length} valid`);
  }
  console.log();

  // Filter by overlap
  console.log(`[3/3] Filtering by token overlap (max ${MAX_SHARED} shared)...`);
  const kept: Array<{ fact: FactRow; q: string; a: string; overlap: number }> = [];
  for (const g of generated) {
    const qTok = tokens(g.q);
    const fTok = new Set<string>([
      ...tokens(g.fact.entity),
      ...tokens(g.fact.key ?? ""),
      ...tokens(g.fact.value),
      ...tokens(g.fact.text ?? ""),
    ]);
    const overlap = [...qTok].filter(t => fTok.has(t)).length;
    kept.push({ ...g, overlap });
  }
  kept.sort((a, b) => a.overlap - b.overlap);
  const cleanest = kept.filter(k => k.overlap <= MAX_SHARED).slice(0, TARGET_GENERATED);
  console.log(`  Kept ${cleanest.length}/${kept.length} (cleanest by overlap)`);

  // Compose final seed
  const newFacts = cleanest.map(c => ({
    id: c.fact.id,
    persona: c.fact.persona,
    entity: c.fact.entity,
    key: c.fact.key,
    value: c.fact.value,
    text: c.fact.text ?? c.fact.value,
  }));
  const newQuestions = cleanest.map((c, i) => ({
    id: `qg${(i + 1).toString().padStart(3, "0")}`,
    fact_id: c.fact.id,
    question: c.q,
    expected_answer: c.a,
    overlap_tokens: c.overlap,
  }));

  const seed = {
    metadata: {
      ...hand.metadata,
      name: "RAG-Only Benchmark (100Q)",
      description: `30 hand-crafted Q/A + ${newQuestions.length} auto-generated Q/A from real shared-facts.db. Max ${MAX_SHARED} token overlap allowed per question.`,
      generated_at: new Date().toISOString(),
    },
    facts: [...hand.facts, ...newFacts],
    questions: [...hand.questions, ...newQuestions],
  };
  writeFileSync(OUT, JSON.stringify(seed, null, 2));
  console.log(`✅ Wrote ${OUT}`);
  console.log(`   ${seed.facts.length} facts, ${seed.questions.length} questions`);
  console.log(`   Mean overlap (generated): ${(cleanest.reduce((s,c)=>s+c.overlap,0)/cleanest.length).toFixed(2)} tokens`);
}

main().catch(e => { console.error(e); process.exit(1); });
