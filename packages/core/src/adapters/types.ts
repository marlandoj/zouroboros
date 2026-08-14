/**
 * Runtime capability adapters.
 *
 * MVP primitives (consensus-gate, healers, watchdogs) were born coupled to Zo
 * platform bindings: notifications via `send_email_to_user`/`send_sms_to_user`,
 * recurring runs via Zo automations, and agent/model management + LLM probes via
 * the Zo MCP + `/zo/ask` surface. These interfaces let those primitives run on a
 * bare Node box: a Zo adapter preserves current behavior when Zo is reachable,
 * and a no-op/console fallback keeps them running (degraded, never crashing)
 * when it is not.
 */

export type AdapterMode = 'zo' | 'noop';

export type NotifyChannel = 'email' | 'sms' | 'auto';

export interface NotifyMessage {
  subject: string;
  body: string;
  channel?: NotifyChannel;
}

/** Delivers operator notifications (alerts, heartbeats, watchdog messages). */
export interface Notifier {
  readonly kind: AdapterMode;
  notify(msg: NotifyMessage): Promise<void>;
}

export interface ScheduleSpec {
  /** Stable identifier for the recurring job. */
  name: string;
  /** Shell command the schedule should run. */
  command: string;
  /** Cron expression (used by the bare-box fallback). */
  cron?: string;
  /** Convenience interval; adapters may translate to cron. */
  intervalMinutes?: number;
}

export interface ScheduleResult {
  /** True when the adapter actually registered the recurring job itself. */
  scheduled: boolean;
  /** Human-readable steps to register the job when the adapter cannot. */
  instructions?: string;
}

/** Registers recurring execution of a primitive. */
export interface Scheduler {
  readonly kind: AdapterMode;
  schedule(spec: ScheduleSpec): Promise<ScheduleResult>;
}

export interface AgentDescriptor {
  id: string;
  title?: string;
  model?: string;
  active?: boolean;
}

export interface ProbeRequest {
  model: string;
  prompt: string;
  timeoutMs?: number;
}

export interface ProbeResponse {
  ok: boolean;
  output?: string;
  status?: number;
  error?: string;
}

/**
 * The agent/model surface: enumerate agents, retarget their model, and probe a
 * model for liveness. On Zo this is the MCP `list_agents`/`edit_agent` +
 * `/zo/ask` transport; off Zo agent management is unavailable and probes report
 * "no transport" so callers can fall back to their own provider chain.
 */
export interface AgentRegistry {
  readonly kind: AdapterMode;
  /** Whether agent management (list/setModel) is possible in this environment. */
  available(): boolean;
  list(): Promise<AgentDescriptor[]>;
  /** Returns true when the model was changed; false when unsupported. */
  setModel(agentId: string, model: string): Promise<boolean>;
  probe(req: ProbeRequest): Promise<ProbeResponse>;
}

export interface Adapters {
  mode: AdapterMode;
  notifier: Notifier;
  scheduler: Scheduler;
  agents: AgentRegistry;
}
