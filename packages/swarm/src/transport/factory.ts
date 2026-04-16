/**
 * Transport factory — resolves the correct ExecutorTransport for a registry entry.
 *
 * Reads the optional `transport` field from the executor registry entry.
 * Defaults to 'bridge' for backward compatibility.
 */

import type { ExecutorRegistryEntry } from '../types.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import { BridgeTransport } from './bridge-transport.js';
import { ACPTransport } from './acp-transport.js';
import { MimirTransport } from './mimir-transport.js';
import type { ExecutorTransport, TransportType } from './types.js';

/** Per-executor ACP adapter config. */
interface AdapterSpec {
  bin: string;
  args?: string[];
}

const ACP_ADAPTERS: Record<string, AdapterSpec> = {
  'claude-code': { bin: 'claude-agent-acp' },
  'codex': { bin: 'codex-acp' },
  'gemini': { bin: 'gemini', args: ['--acp'] },
};

export function createTransport(
  entry: ExecutorRegistryEntry,
  circuitBreaker: CircuitBreaker,
): ExecutorTransport {
  const transport: TransportType = entry.transport ?? 'bridge';

  switch (transport) {
    case 'bridge':
      return new BridgeTransport(entry, circuitBreaker);
    case 'acp': {
      const spec = ACP_ADAPTERS[entry.id];
      if (!spec) {
        throw new Error(
          `No ACP adapter mapping for executor '${entry.id}'. ` +
          `Add an entry to ACP_ADAPTERS in transport/factory.ts.`,
        );
      }
      return new ACPTransport(entry, circuitBreaker, {
        adapterBin: spec.bin,
        adapterArgs: spec.args,
      });
    }
    case 'mimir': {
      const gateUrl = process.env.MIMIR_GATE_URL || 'http://localhost:7820';
      return new MimirTransport(gateUrl);
    }
    default:
      throw new Error(`Unknown transport type '${transport}' for executor '${entry.id}'`);
  }
}
