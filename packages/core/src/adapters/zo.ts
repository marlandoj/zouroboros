/**
 * Zo-platform adapters. Preserve the primitives' native behavior — MCP calls for
 * notifications and agent management, `/zo/ask` for model probes — when a Zo
 * client-identity token is present.
 */

import type {
  AdapterMode,
  AgentDescriptor,
  AgentRegistry,
  Notifier,
  NotifyMessage,
  ProbeRequest,
  ProbeResponse,
  ScheduleResult,
  Scheduler,
  ScheduleSpec,
} from './types.js';

const DEFAULT_MCP_ENDPOINT = 'https://api.zo.computer/mcp';
const DEFAULT_ASK_ENDPOINT = 'https://api.zo.computer/zo/ask';

export interface ZoAdapterConfig {
  token: string;
  mcpEndpoint?: string;
  askEndpoint?: string;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
}

interface ResolvedConfig extends Required<Omit<ZoAdapterConfig, 'logger'>> {
  logger: (line: string) => void;
}

function resolve(config: ZoAdapterConfig): ResolvedConfig {
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (typeof fetchImpl !== 'function') {
    throw new Error('ZoAdapter requires a fetch implementation');
  }
  return {
    token: config.token,
    mcpEndpoint: config.mcpEndpoint ?? DEFAULT_MCP_ENDPOINT,
    askEndpoint: config.askEndpoint ?? DEFAULT_ASK_ENDPOINT,
    fetchImpl,
    logger: config.logger ?? (() => {}),
  };
}

async function mcpCall(
  cfg: ResolvedConfig,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 45_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await cfg.fetchImpl(cfg.mcpEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });
    const data = (await resp.json()) as {
      error?: { message?: string };
      result?: { content?: Array<{ text?: string }> };
    };
    if (data.error) {
      throw new Error(`MCP ${toolName} failed: ${data.error.message}`);
    }
    return data.result?.content?.[0]?.text ?? '';
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`MCP ${toolName} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the flat `id='…' title='…' model='…' active=True` text list_agents returns. */
export function parseAgentList(raw: string): AgentDescriptor[] {
  const agents: AgentDescriptor[] = [];
  for (const entry of raw.split(/(?=id=')/)) {
    const id = /id='([^']+)'/.exec(entry)?.[1];
    const model = /model='([^']+)'/.exec(entry)?.[1];
    if (!id || !model) continue;
    agents.push({
      id,
      title: /title='([^']+)'/.exec(entry)?.[1] ?? 'Untitled',
      model,
      active: /active=(True|False)/.exec(entry)?.[1] !== 'False',
    });
  }
  return agents;
}

export class ZoNotifier implements Notifier {
  readonly kind: AdapterMode = 'zo';
  constructor(private readonly cfg: ResolvedConfig) {}

  async notify(msg: NotifyMessage): Promise<void> {
    const tool = msg.channel === 'sms' ? 'send_sms_to_user' : 'send_email_to_user';
    const args =
      tool === 'send_sms_to_user'
        ? { message: `${msg.subject}\n\n${msg.body}`.trim() }
        : { subject: msg.subject, body: msg.body };
    try {
      await mcpCall(this.cfg, tool, args);
    } catch (err) {
      this.cfg.logger(`[notify] Zo delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export class ZoScheduler implements Scheduler {
  readonly kind: AdapterMode = 'zo';
  constructor(private readonly cfg: ResolvedConfig) {}

  async schedule(spec: ScheduleSpec): Promise<ScheduleResult> {
    // Registering Zo automations is an operator action (create_automation); the
    // adapter surfaces the intent rather than silently mutating platform state.
    const cadence = spec.cron
      ? `cron "${spec.cron}"`
      : spec.intervalMinutes
        ? `every ${spec.intervalMinutes}m`
        : 'a cadence you choose';
    return {
      scheduled: false,
      instructions:
        `Create a Zo automation named "${spec.name}" running \`${spec.command}\` on ${cadence}.`,
    };
  }
}

export class ZoAgentRegistry implements AgentRegistry {
  readonly kind: AdapterMode = 'zo';
  constructor(private readonly cfg: ResolvedConfig) {}

  available(): boolean {
    return true;
  }

  async list(): Promise<AgentDescriptor[]> {
    return parseAgentList(await mcpCall(this.cfg, 'list_agents', {}));
  }

  async setModel(agentId: string, model: string): Promise<boolean> {
    await mcpCall(this.cfg, 'edit_agent', { agent_id: agentId, model });
    return true;
  }

  async probe(req: ProbeRequest): Promise<ProbeResponse> {
    const timeoutMs = req.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await this.cfg.fetchImpl(this.cfg.askEndpoint, {
        method: 'POST',
        headers: { authorization: this.cfg.token, 'content-type': 'application/json' },
        body: JSON.stringify({ input: req.prompt, model_name: req.model }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { ok: false, status: resp.status, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      const data = (await resp.json()) as { output?: unknown };
      return { ok: true, status: resp.status, output: (data.output ?? '').toString() };
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : String(err);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createZoAdapters(config: ZoAdapterConfig) {
  const cfg = resolve(config);
  return {
    notifier: new ZoNotifier(cfg),
    scheduler: new ZoScheduler(cfg),
    agents: new ZoAgentRegistry(cfg),
  };
}
