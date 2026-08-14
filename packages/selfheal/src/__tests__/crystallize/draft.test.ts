/**
 * Module coverage for draft.ts. Uses a stub LLM driver — the production driver
 * (model-client / gpt-4o-mini) is wired in PR3's CLI.
 */

import { describe, expect, test } from 'bun:test';
import { draftCandidate, SKILL_MD_SYSTEM } from '../../crystallize/draft.js';
import { weightSources } from '../../crystallize/score.js';

const stubLlm = (canned: string, cost = 0.0042) =>
  async (_prompt: string) => ({ content: canned, cost_usd: cost });

describe('crystallize/draft', () => {
  test('produces SKILL.md + one stub script per tool call', async () => {
    const [candidate] = weightSources({
      coldStart: false,
      procedures: [
        { kind: 'procedure', id: 'p1', name: 'deploy-zo-route', steps: [], success_count: 5, failure_count: 0 },
        { kind: 'procedure', id: 'p2', name: 'deploy-zo-route', steps: [], success_count: 3, failure_count: 0 },
        { kind: 'procedure', id: 'p3', name: 'deploy-zo-route', steps: [], success_count: 4, failure_count: 0 },
      ],
      episodes: [],
      skillExecutions: [],
    });
    expect(candidate).toBeDefined();

    const out = await draftCandidate(candidate!, {
      slug: 'deploy-zo-route',
      toolCalls: [
        { tool: 'Bash', sample_args: { command: 'pnpm test' } },
        { tool: 'mcp__zo__write_space_route', sample_args: { path: '/api/x' } },
      ],
      llm: stubLlm('---\nname: deploy-zo-route\ndescription: ships a route\n---\n\n# deploy-zo-route\n'),
    });

    expect(out.slug).toBe('deploy-zo-route');
    expect(out.llm_cost_usd).toBeCloseTo(0.0042);
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'SKILL.md',
      'scripts/bash.ts',
      'scripts/mcp-zo-write-space-route.ts',
    ]);
    const skillMd = out.files.find((f) => f.path === 'SKILL.md')!.content;
    expect(skillMd).toContain('deploy-zo-route');
  });

  test('SKILL_MD_SYSTEM forbids shell snippets', () => {
    expect(SKILL_MD_SYSTEM).toContain('no shell commands');
  });
});
