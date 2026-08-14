import { describe, expect, test } from 'bun:test';

describe('standalone model client OpenRouter compatibility', () => {
  test('routes openrouter:model specs through the OpenRouter chat endpoint', async () => {
    const script = `
      globalThis.fetch = async (url, init) => {
        if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('unexpected URL');
        const body = JSON.parse(init.body);
        if (body.model !== 'google/gemini-2.5-flash') throw new Error('unexpected model');
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'router-ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = await import(${JSON.stringify(`${import.meta.dir}/../standalone/model-client.ts`)});
      const result = await client.generate({
        prompt: 'test',
        workload: 'summarization',
        model: 'openrouter:google/gemini-2.5-flash',
      });
      console.log(JSON.stringify({ content: result.content, provider: result.provider, model: result.model }));
    `;
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: import.meta.dir,
      env: { ...process.env, OPENROUTER_API_KEY: 'test-token' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      content: 'router-ok',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
    });
  });
});
