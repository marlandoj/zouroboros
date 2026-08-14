import type { CommandHub, CommandResult, ParsedCommand } from './commands.js';

export const OPERATOR_SHORTCUT_VERSION = 1 as const;

export type OperatorShortcutId =
  | 'status'
  | 'doctor'
  | 'governance-verify'
  | 'memory-search'
  | 'swarm-status';

export interface ShortcutWorkflow {
  program: 'bun';
  args: string[];
  readOnly: true;
}

export interface OperatorShortcutEnvelope {
  kind: 'zouroboros.operator-shortcut';
  version: typeof OPERATOR_SHORTCUT_VERSION;
  id: OperatorShortcutId;
  canonicalPhrase: string;
  input: string;
  arguments: Record<string, string>;
  workflow: ShortcutWorkflow;
  readOnly: true;
}

export interface ShortcutDefinition {
  id: OperatorShortcutId;
  canonicalPhrase: string;
  paraphrases: string[];
  argumentPrefixes?: string[];
  workflow: ShortcutWorkflow;
}

export type ShortcutResolution =
  | { kind: 'match'; envelope: OperatorShortcutEnvelope }
  | { kind: 'no-op'; reason: 'unsupported' | 'ambiguous' | 'missing-argument'; candidates: OperatorShortcutId[]; help: string };

export interface ShortcutExecutionResult {
  kind: 'zouroboros.operator-shortcut-result';
  version: typeof OPERATOR_SHORTCUT_VERSION;
  id?: OperatorShortcutId;
  status: 'ok' | 'error' | 'no-op';
  output: string;
  data?: unknown;
  error?: string;
}

export type OperatorShortcutExecutor = (envelope: OperatorShortcutEnvelope) =>
  Promise<Omit<ShortcutExecutionResult, 'kind' | 'version' | 'id'>> |
  Omit<ShortcutExecutionResult, 'kind' | 'version' | 'id'>;

export const OPERATOR_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'status',
    canonicalPhrase: '/status',
    paraphrases: ['zouroboros status', 'show zouroboros status', 'show system status'],
    workflow: { program: 'bun', args: ['Skills/zouroboros/skills/selfheal/scripts/introspect.ts', '--json'], readOnly: true },
  },
  {
    id: 'doctor',
    canonicalPhrase: '/doctor',
    paraphrases: ['zouroboros doctor', 'run zouroboros doctor', 'check zouroboros health'],
    workflow: { program: 'bun', args: ['Skills/zouroboros/scripts/doctor.ts', '--json'], readOnly: true },
  },
  {
    id: 'governance-verify',
    canonicalPhrase: '/governance verify',
    paraphrases: ['verify governance', 'verify zouroboros governance', 'check constitutional documents'],
    workflow: { program: 'bun', args: ['Skills/zouroboros-governance/scripts/constitution-gate.ts', 'verify-docs'], readOnly: true },
  },
  {
    id: 'memory-search',
    canonicalPhrase: '/memory search',
    paraphrases: [],
    argumentPrefixes: ['/memory search ', 'search memory for ', 'search my memory for '],
    workflow: { program: 'bun', args: ['.zo/memory/scripts/memory.ts', 'search'], readOnly: true },
  },
  {
    id: 'swarm-status',
    canonicalPhrase: '/swarm status',
    paraphrases: ['swarm status', 'show swarm status', 'check swarm status'],
    workflow: { program: 'bun', args: ['packages/swarm/scripts/orchestrate-v5.ts', 'doctor'], readOnly: true },
  },
] as const;

const HELP = 'Read-only shortcuts: /status, /doctor, /governance verify, /memory search "query", /swarm status';

function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

function makeEnvelope(definition: ShortcutDefinition, input: string, args: Record<string, string>): OperatorShortcutEnvelope {
  const workflowArgs = [...definition.workflow.args];
  if (definition.id === 'memory-search') workflowArgs.push(args.query, '--no-hyde');
  return {
    kind: 'zouroboros.operator-shortcut',
    version: OPERATOR_SHORTCUT_VERSION,
    id: definition.id,
    canonicalPhrase: definition.canonicalPhrase,
    input,
    arguments: args,
    workflow: { ...definition.workflow, args: workflowArgs },
    readOnly: true,
  };
}

export function resolveOperatorShortcut(
  input: string,
  catalog: readonly ShortcutDefinition[] = OPERATOR_SHORTCUTS,
): ShortcutResolution {
  const normalized = normalize(input);
  const matches: OperatorShortcutEnvelope[] = [];
  let missingArgument = false;

  for (const definition of catalog) {
    const exact = [definition.canonicalPhrase, ...definition.paraphrases].map(normalize);
    if (exact.includes(normalized)) {
      if (definition.argumentPrefixes?.length) missingArgument = true;
      else matches.push(makeEnvelope(definition, input, {}));
    }
    for (const prefix of definition.argumentPrefixes ?? []) {
      const normalizedPrefix = normalize(prefix);
      if (!normalized.startsWith(normalizedPrefix)) continue;
      const query = input.trim().slice(prefix.trim().length).trim().replace(/^("|')|("|')$/g, '');
      if (query) matches.push(makeEnvelope(definition, input, { query }));
      else missingArgument = true;
    }
  }

  const unique = [...new Map(matches.map((match) => [match.id, match])).values()];
  if (unique.length === 1) return { kind: 'match', envelope: unique[0] };
  if (unique.length > 1) {
    return { kind: 'no-op', reason: 'ambiguous', candidates: unique.map((match) => match.id), help: HELP };
  }
  return { kind: 'no-op', reason: missingArgument ? 'missing-argument' : 'unsupported', candidates: [], help: HELP };
}

export async function executeOperatorShortcut(
  input: string,
  executor: OperatorShortcutExecutor,
  catalog: readonly ShortcutDefinition[] = OPERATOR_SHORTCUTS,
): Promise<ShortcutExecutionResult> {
  const resolution = resolveOperatorShortcut(input, catalog);
  if (resolution.kind === 'no-op') {
    return {
      kind: 'zouroboros.operator-shortcut-result',
      version: OPERATOR_SHORTCUT_VERSION,
      status: 'no-op',
      output: resolution.help,
      error: resolution.reason,
    };
  }
  const result = await executor(resolution.envelope);
  return {
    kind: 'zouroboros.operator-shortcut-result',
    version: OPERATOR_SHORTCUT_VERSION,
    id: resolution.envelope.id,
    ...result,
  };
}

function commandHandler(input: (parsed: ParsedCommand) => string, executor: OperatorShortcutExecutor) {
  return async (parsed: ParsedCommand): Promise<CommandResult> => {
    const result = await executeOperatorShortcut(input(parsed), executor);
    return { success: result.status === 'ok', output: result.output, data: result.data, error: result.error };
  };
}

export function registerOperatorShortcuts(hub: CommandHub, executor: OperatorShortcutExecutor): void {
  hub.register({ name: '/status', aliases: [], description: 'Read Zouroboros status', usage: '/status', category: 'operator', args: [], handler: commandHandler(() => '/status', executor) });
  hub.register({ name: '/doctor', aliases: [], description: 'Run the read-only Zouroboros doctor', usage: '/doctor', category: 'operator', args: [], handler: commandHandler(() => '/doctor', executor) });
  hub.register({ name: '/governance', aliases: [], description: 'Inspect governance state', usage: '/governance verify', category: 'operator', args: [], handler: commandHandler(() => '/governance verify', executor) });
  hub.registerSubcommand('/governance', { name: 'verify', description: 'Verify constitutional documents', usage: '/governance verify', args: [], handler: commandHandler(() => '/governance verify', executor) });
  hub.register({ name: '/memory', aliases: [], description: 'Read memory state', usage: '/memory search "query"', category: 'operator', args: [], handler: commandHandler(() => '/memory search', executor) });
  hub.registerSubcommand('/memory', { name: 'search', description: 'Search memory read-only', usage: '/memory search "query"', args: [{ name: 'query', description: 'Search query', required: true, type: 'string' }], handler: commandHandler((parsed) => `/memory search "${String(parsed.args.query)}"`, executor) });
  hub.register({ name: '/swarm', aliases: [], description: 'Inspect swarm state', usage: '/swarm status', category: 'operator', args: [], handler: commandHandler(() => '/swarm status', executor) });
  hub.registerSubcommand('/swarm', { name: 'status', description: 'Read swarm status', usage: '/swarm status', args: [], handler: commandHandler(() => '/swarm status', executor) });
}
