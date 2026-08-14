import { Command } from 'commander';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { createRequire } from 'module';
import { existsSync } from 'fs';

const nodeRequire = createRequire(import.meta.url);

/**
 * Locate the memory-gate daemon entry point.
 *
 * Preference order:
 *   1. `zouroboros-memory/gate-server` subpath export — works when this CLI is
 *      installed as a published npm package alongside `zouroboros-memory`.
 *   2. Monorepo-relative source path — works when running directly from a clone.
 */
let cachedGateServer: string | undefined;
function resolveGateServer(): string {
  if (cachedGateServer) return cachedGateServer;
  try {
    cachedGateServer = nodeRequire.resolve('zouroboros-memory/gate-server');
    return cachedGateServer;
  } catch {
    // fall through to monorepo fallback
  }
  const monorepoPath = resolve(
    import.meta.dirname || __dirname,
    '../../../packages/memory/src/gate-server.ts',
  );
  if (existsSync(monorepoPath)) {
    cachedGateServer = monorepoPath;
    return cachedGateServer;
  }
  throw new Error(
    'Unable to locate the memory-gate daemon. Install `zouroboros-memory` or run from a monorepo clone with packages/memory present.',
  );
}

function gateEndpoint(): string {
  const host = process.env.ZO_GATE_HOST || '127.0.0.1';
  const port = process.env.PORT || '7820';
  return `http://${host}:${port}`;
}

export const gateCommand = new Command('gate')
  .description('Memory-gate daemon (UserPromptSubmit context injection)')
  .addCommand(
    new Command('start')
      .description('Start the memory-gate daemon (foreground)')
      .option('--port <n>', 'Port to listen on (default 7820)')
      .option('--insecure', 'Disable auth and bind 127.0.0.1 only (localhost dev)')
      .action((options) => {
        let target: string;
        try {
          target = resolveGateServer();
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
          return;
        }
        const args = [target];
        if (options.insecure) args.push('--insecure');
        const env = { ...process.env };
        if (options.port) env.PORT = String(options.port);
        const child = spawn('bun', args, { stdio: 'inherit', env });
        child.on('error', (err) => {
          console.error(`Failed to spawn memory-gate daemon: ${err.message}`);
          process.exitCode = 1;
        });
        child.on('exit', (code) => {
          if (code && code !== 0) process.exitCode = code;
        });
      }),
  )
  .addCommand(
    new Command('status')
      .description('Check whether the memory-gate daemon is running')
      .action(async () => {
        const endpoint = gateEndpoint();
        try {
          const resp = await fetch(`${endpoint}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!resp.ok) {
            console.error(`Daemon at ${endpoint} returned HTTP ${resp.status}`);
            process.exitCode = 1;
            return;
          }
          const health = await resp.json();
          console.log(JSON.stringify(health, null, 2));
        } catch {
          console.error(`No memory-gate daemon reachable at ${endpoint}`);
          console.error('Start it with: zouroboros gate start');
          process.exitCode = 1;
        }
      }),
  );
