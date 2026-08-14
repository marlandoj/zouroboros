/**
 * Lightweight LLM client for memory retrieval enhancement (reranker, CoT).
 *
 * Routes to OpenAI based on model spec.
 * Model spec format: "provider:model" or bare model name.
 */

export type LlmProvider = 'openai';

export interface LlmCallOptions {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmCallResult {
  content: string;
  latencyMs: number;
  provider: LlmProvider;
  model: string;
}

const KNOWN_OPENAI = new Set([
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4',
  'gpt-3.5-turbo', 'o1', 'o1-mini', 'o3-mini',
]);

function parseSpec(spec: string): { provider: LlmProvider; model: string } {
  if (!spec) return { provider: 'openai', model: 'gpt-4o-mini' };
  const colon = spec.indexOf(':');
  if (colon >= 0) {
    const prefix = spec.slice(0, colon).toLowerCase();
    if (prefix === 'openai') {
      return { provider: prefix, model: spec.slice(colon + 1) };
    }
  }
  if (KNOWN_OPENAI.has(spec)) return { provider: 'openai', model: spec };
  return { provider: 'openai', model: spec.slice(colon + 1) || spec };
}

async function callOpenai(opts: LlmCallOptions, model: string): Promise<LlmCallResult> {
  const key = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const start = Date.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 200,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return {
    content: data.choices?.[0]?.message?.content?.trim() || '',
    latencyMs: Date.now() - start,
    provider: 'openai',
    model,
  };
}

export async function llmCall(opts: LlmCallOptions): Promise<LlmCallResult> {
  const { provider, model } = parseSpec(opts.model || 'gpt-4o-mini');
  switch (provider) {
    case 'openai': return callOpenai(opts, model);
  }
}
