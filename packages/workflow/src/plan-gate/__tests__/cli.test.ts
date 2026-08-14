import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { dir: string; plan: string; ledger: string; receipt: string } {
  const dir = mkdtempSync(join(tmpdir(), 'plan-gate-cli-'));
  dirs.push(dir);
  const plan = join(dir, 'plan.yaml');
  writeFileSync(plan, [
    'id: plan-cli',
    'title: CLI verification plan',
    'risk: high',
    'revision: 1',
    'tasks:',
    '  - id: TASK-1',
    '    title: Verify CLI behavior',
    'acceptance_criteria:',
    '  - criterion: The CLI returns a verified result.',
    'exit_conditions:',
    '  - name: verified',
    '    criteria: The focused CLI tests pass.',
    'rollback: Disable the plan gate integration.',
    '',
  ].join('\n'));
  return { dir, plan, ledger: join(dir, 'audit.jsonl'), receipt: join(dir, 'receipt.json') };
}

async function run(args: string[], env: Record<string, string | undefined> = process.env) {
  const cli = resolve(import.meta.dir, '../../cli/plan-gate.ts');
  const child = Bun.spawn(['bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe', env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('zouroboros-plan-gate CLI', () => {
  test('validates and reviews a plan through the subprocess provider contract', async () => {
    const paths = workspace();
    const validate = await run(['validate', '--plan', paths.plan, '--workspace-root', paths.dir, '--json']);
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(validate.stdout).deterministic_report.passed).toBe(true);

    const provider = resolve(import.meta.dir, '../__fixtures__/mock-provider.ts');
    const review = await run([
      'review', '--plan', paths.plan, '--workspace-root', paths.dir,
      '--provider-command', 'bun', '--provider-arg', provider,
      '--ledger', paths.ledger, '--json',
    ]);
    expect(review.stderr).toBe('');
    expect(review.exitCode).toBe(0);
    expect(JSON.parse(review.stdout).decision).toBe('passed');
    expect(readFileSync(paths.ledger, 'utf8')).toContain('mock-provider');
  });

  test('issues and verifies an enforcement receipt', async () => {
    const paths = workspace();
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    const env = {
      ...process.env,
      PLAN_GATE_SIGNING_PRIVATE_KEY: keys.privateKey,
      PLAN_GATE_SIGNING_KEY_ID: 'key-1',
      PLAN_GATE_TRUSTED_PUBLIC_KEYS: JSON.stringify({ 'key-1': keys.publicKey }),
    };
    const accept = await run([
      'accept', '--plan', paths.plan,
      '--actor-id', 'operator-1', '--actor-source', 'test-auth',
      '--authorization', 'project-owner', '--gate-run-id', 'gate-1',
      '--out', paths.receipt, '--ledger', paths.ledger, '--json',
    ], env);
    expect(accept.exitCode).toBe(0);
    expect(JSON.parse(accept.stdout).receipt.enforcement_eligible).toBe(true);

    const inspect = await run([
      'inspect', '--receipt', paths.receipt, '--mode', 'enforce', '--json',
    ], env);
    expect(inspect.exitCode).toBe(0);
    expect(JSON.parse(inspect.stdout).verification.valid).toBe(true);
  });
});
