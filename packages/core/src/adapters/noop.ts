/**
 * Bare-box fallback adapters. No platform bindings: notifications print to the
 * console, scheduling returns crontab instructions instead of registering, and
 * agent management is unavailable so healers degrade to probe-and-report. These
 * keep MVP primitives running (degraded, never crashing) with zero Zo access.
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

export interface NoopAdapterConfig {
  /** Sink for console output; defaults to console.error (stderr). */
  logger?: (line: string) => void;
}

function loggerOf(config?: NoopAdapterConfig): (line: string) => void {
  return config?.logger ?? ((line: string) => console.error(line));
}

export class NoopNotifier implements Notifier {
  readonly kind: AdapterMode = 'noop';
  constructor(private readonly log: (line: string) => void) {}

  async notify(msg: NotifyMessage): Promise<void> {
    const channel = msg.channel && msg.channel !== 'auto' ? ` via ${msg.channel}` : '';
    this.log(`[notify${channel}] ${msg.subject}\n${msg.body}`);
  }
}

export class NoopScheduler implements Scheduler {
  readonly kind: AdapterMode = 'noop';
  constructor(private readonly log: (line: string) => void) {}

  async schedule(spec: ScheduleSpec): Promise<ScheduleResult> {
    const cron = spec.cron ?? (spec.intervalMinutes ? `*/${spec.intervalMinutes} * * * *` : '*/30 * * * *');
    const line = `${cron} ${spec.command}  # ${spec.name}`;
    this.log(`[schedule] add to crontab:\n${line}`);
    return {
      scheduled: false,
      instructions: `Add to crontab (\`crontab -e\`):\n${line}`,
    };
  }
}

export class NoopAgentRegistry implements AgentRegistry {
  readonly kind: AdapterMode = 'noop';
  constructor(private readonly log: (line: string) => void) {}

  available(): boolean {
    return false;
  }

  async list(): Promise<AgentDescriptor[]> {
    this.log('[agents] agent management is Zo-only; none available on a bare box');
    return [];
  }

  async setModel(_agentId: string, _model: string): Promise<boolean> {
    this.log('[agents] setModel unsupported without a Zo binding; skipping');
    return false;
  }

  async probe(req: ProbeRequest): Promise<ProbeResponse> {
    return {
      ok: false,
      error: `no transport adapter for model "${req.model}" (Zo unavailable); caller should use its own provider chain`,
    };
  }
}

export function createNoopAdapters(config?: NoopAdapterConfig) {
  const log = loggerOf(config);
  return {
    notifier: new NoopNotifier(log),
    scheduler: new NoopScheduler(log),
    agents: new NoopAgentRegistry(log),
  };
}
