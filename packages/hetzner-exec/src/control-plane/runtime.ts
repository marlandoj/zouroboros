import { createControlPlaneApi } from "./api";
import { ShadowCoordinator } from "./coordinator";
import { ControlPlaneStore } from "./store";

export interface ControlPlaneRuntime {
  coordinator: ShadowCoordinator;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export function createControlPlaneRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): ControlPlaneRuntime {
  const mode = env.HETZNER_CONTROL_PLANE_MODE ?? "shadow";
  if (mode !== "shadow") throw new Error(`control plane refuses mode: ${mode}`);
  const token = env.HETZNER_CONTROL_PLANE_TOKEN ?? "";
  if (!token) throw new Error("HETZNER_CONTROL_PLANE_TOKEN is required");
  const stateDir = env.HETZNER_CONTROL_PLANE_STATE_DIR ?? "/var/lib/zouroboros-control-plane";
  const host = env.HETZNER_CONTROL_PLANE_HOST ?? "127.0.0.1";
  const port = integerEnv(env.HETZNER_CONTROL_PLANE_PORT, 6670, "HETZNER_CONTROL_PLANE_PORT");
  const pollMs = integerEnv(env.HETZNER_CONTROL_PLANE_POLL_MS, 2_000, "HETZNER_CONTROL_PLANE_POLL_MS");
  const coordinator = new ShadowCoordinator(new ControlPlaneStore(stateDir), {
    workerId: env.HETZNER_CONTROL_PLANE_WORKER_ID,
    leaseTtlMs: integerEnv(env.HETZNER_CONTROL_PLANE_LEASE_TTL_MS, 60_000, "HETZNER_CONTROL_PLANE_LEASE_TTL_MS"),
    retryBaseMs: integerEnv(env.HETZNER_CONTROL_PLANE_RETRY_BASE_MS, 5_000, "HETZNER_CONTROL_PLANE_RETRY_BASE_MS"),
    maxAttempts: integerEnv(env.HETZNER_CONTROL_PLANE_MAX_ATTEMPTS, 3, "HETZNER_CONTROL_PLANE_MAX_ATTEMPTS"),
  });
  const api = createControlPlaneApi(coordinator, { authToken: token, host, port });
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  return {
    coordinator,
    async start() {
      coordinator.reconcile();
      await api.listen();
      timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        void coordinator.tick().finally(() => {
          ticking = false;
        });
      }, pollMs);
      timer.unref();
      return api.address();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await api.close();
    },
  };
}

function integerEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
