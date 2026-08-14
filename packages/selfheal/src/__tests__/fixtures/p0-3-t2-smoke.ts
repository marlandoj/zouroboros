/**
 * T2 live smoke (not a unit test — run with `bun`):
 *   1. case-id parity: the grader emits the SAME HOLDOUT_CASE id set whether it
 *      runs under the hermetic sandbox env or full inheritance.
 *   2. secret-echo: a canary secret set in the parent is INVISIBLE to a child
 *      spawned with the sandbox env, but VISIBLE under full inheritance.
 */
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildHoldoutSandboxEnv } from '../../introspect/holdout-sandbox.js';

const RUNNER = fileURLToPath(new URL('../../standalone/holdout-eval.ts', import.meta.url));
const WORKSPACE = process.env.ZO_WORKSPACE || '/home/workspace';

function caseIds(out: string): Set<string> {
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^HOLDOUT_CASE\s+(\S+)\s+([01])\s*$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function runGrader(env: NodeJS.ProcessEnv | undefined): string {
  return execSync(`bun "${RUNNER}" 2>/dev/null`, {
    cwd: WORKSPACE,
    timeout: 60000,
    encoding: 'utf-8',
    env,
  });
}

// Inject a canary secret into the parent for the duration of this smoke.
const parent: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: 'CANARY-SECRET-123' };

const sandboxOut = runGrader(buildHoldoutSandboxEnv(parent));
const legacyOut = runGrader(undefined); // full inheritance

const sandboxIds = caseIds(sandboxOut);
const legacyIds = caseIds(legacyOut);

const same =
  sandboxIds.size > 0 &&
  sandboxIds.size === legacyIds.size &&
  [...sandboxIds].every((id) => legacyIds.has(id));

console.log(`[parity] sandbox ids=${sandboxIds.size} legacy ids=${legacyIds.size} identical=${same}`);
if (!same) {
  console.log(`[parity] sandbox: ${[...sandboxIds].sort().join(',')}`);
  console.log(`[parity] legacy:  ${[...legacyIds].sort().join(',')}`);
}

// secret-echo: spawn a child that prints the canary, once per env.
function echoSecret(env: NodeJS.ProcessEnv | undefined): string {
  return execSync(`bun -e "process.stdout.write(process.env.OPENAI_API_KEY ?? 'EMPTY')"`, {
    encoding: 'utf-8',
    env,
  }).trim();
}

const echoedSandbox = echoSecret(buildHoldoutSandboxEnv(parent));
const echoedLegacy = echoSecret(parent);
console.log(`[secret-echo] sandbox sees: "${echoedSandbox}" (want EMPTY)`);
console.log(`[secret-echo] legacy  sees: "${echoedLegacy}" (want CANARY-SECRET-123)`);

const pass =
  same && echoedSandbox === 'EMPTY' && echoedLegacy === 'CANARY-SECRET-123';
console.log(`\nT2 SMOKE: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
