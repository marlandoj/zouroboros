// Sandbox execution. `sandbox=true` runs the command in a fresh, isolated
// environment instead of on the host.
//
// Two providers:
//   - docker:  fresh `docker run --rm --network=none` container. ZERO egress
//              (parent reads stdout directly). Always available where docker is.
//   - hcloud:  fresh Hetzner VM, bootstrapped by cloud-init, runs the command,
//              POSTs the result back to the parent's /sandbox/callback/:id,
//              then powers off. Egress is UFW-locked to the parent only — so
//              "the only outbound egress from the sandbox is the result POST."
//
// Both expose the same SandboxProvider shape; the server picks one via config.

import { randomBytes } from "node:crypto";
import type { ExecRequest, RunResult } from "./types";
import { buildDockerArgv, type CommandRunner, type RunnerArgs, EXIT_TIMEOUT } from "./executor";
import { HcloudHttpClient, type HcloudClient, type CreateServerInput } from "./hcloud";
import type { ServerConfig } from "./config";
import { ConfigError } from "./config";

export interface SandboxRunHandle {
  sandboxId: string;
  result: Promise<RunResult>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly kind: string;
  /** Provision + execute. Caller MUST call destroy() on the returned handle in finally. */
  run(req: ExecRequest, timeoutMs: number): Promise<SandboxRunHandle>;
}

export function randomId(): string {
  return randomBytes(6).toString("hex");
}

// ─── Callback registry (hcloud provider) ──────────────────────────────────────

export interface CallbackEntry {
  promise: Promise<RunResult>;
  cleanup: () => void;
}

export interface CallbackRegistry {
  register(runId: string, timeoutMs: number): CallbackEntry;
  deliver(runId: string, result: RunResult): boolean;
  has(runId: string): boolean;
}

export class InMemoryCallbackRegistry implements CallbackRegistry {
  private readonly map = new Map<string, { resolve: (r: RunResult) => void; timer: ReturnType<typeof setTimeout> | null }>();

  register(runId: string, timeoutMs: number): CallbackEntry {
    const entry: { resolve: (r: RunResult) => void; timer: ReturnType<typeof setTimeout> | null } = {
      resolve: () => {},
      timer: null,
    };
    const promise = new Promise<RunResult>((res) => {
      entry.resolve = res;
    });
    entry.timer = setTimeout(() => {
      if (this.map.delete(runId)) {
        entry.resolve({
          exit_code: EXIT_TIMEOUT,
          stdout: "",
          stderr: `sandbox timed out after ${timeoutMs}ms`,
          elapsed_ms: timeoutMs,
          timed_out: true,
        });
      }
    }, timeoutMs);
    this.map.set(runId, { resolve: entry.resolve, timer: entry.timer });
    return {
      promise,
      cleanup: () => {
        if (this.map.delete(runId) && entry.timer) {
          clearTimeout(entry.timer);
        }
      },
    };
  }

  deliver(runId: string, result: RunResult): boolean {
    const e = this.map.get(runId);
    if (!e) return false;
    this.map.delete(runId);
    if (e.timer) clearTimeout(e.timer);
    e.resolve(result);
    return true;
  }

  has(runId: string): boolean {
    return this.map.has(runId);
  }
}

// ─── Docker sandbox ───────────────────────────────────────────────────────────

export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = "docker";
  constructor(private readonly runner: CommandRunner, private readonly defaultImage: string) {}

  run(req: ExecRequest, timeoutMs: number): Promise<SandboxRunHandle> {
    const sandboxId = `docker-${randomId()}`;
    const image = req.docker_image ?? this.defaultImage;
    const argv = buildDockerArgv(image, req.command, req.env, ["--network=none"]);
    const args: RunnerArgs = { argv, env: undefined, timeoutMs };
    const result = this.runner.run(args);
    return Promise.resolve<SandboxRunHandle>({
      sandboxId,
      result,
      destroy: async () => {
        /* `--rm` removes the container on exit; nothing to tear down. */
      },
    });
  }
}

// ─── Hcloud sandbox ───────────────────────────────────────────────────────────

export interface CloudInitContext {
  runId: string;
  callbackUrl: string;
  authToken: string;
  command: string;
}

export interface HcloudSandboxDeps {
  client: HcloudClient;
  callbacks: CallbackRegistry;
  cloudInit: (ctx: CloudInitContext) => string;
  publicBaseUrl: string;
  authToken: string;
  serverType: string;
  image: string;
  location: string;
  sshKeyName: string;
}

export class HcloudSandboxProvider implements SandboxProvider {
  readonly kind = "hcloud";
  constructor(private readonly deps: HcloudSandboxDeps) {}

  async run(req: ExecRequest, timeoutMs: number): Promise<SandboxRunHandle> {
    const runId = `hcloud-${randomId()}`;
    const base = this.deps.publicBaseUrl.replace(/\/+$/, "");
    const callbackUrl = `${base}/sandbox/callback/${runId}`;
    const { promise, cleanup } = this.deps.callbacks.register(runId, timeoutMs);

    const userData = this.deps.cloudInit({
      runId,
      callbackUrl,
      authToken: this.deps.authToken,
      command: req.command,
    });

    let serverId: number;
    try {
      const server = await this.deps.client.createServer({
        name: `sbx-${runId}`,
        serverType: this.deps.serverType,
        image: this.deps.image,
        location: this.deps.location,
        sshKeyName: this.deps.sshKeyName,
        userData,
        labels: { sandbox: "true", runId },
      } satisfies CreateServerInput);
      serverId = server.id;
    } catch (e) {
      cleanup();
      throw e;
    }

    return {
      sandboxId: runId,
      result: promise,
      destroy: async () => {
        cleanup();
        try {
          await this.deps.client.deleteServer(serverId);
        } catch {
          /* best-effort teardown; container/VM may already be gone */
        }
      },
    };
  }
}

// ─── Cloud-init generator (hcloud provider) ───────────────────────────────────

const AGENT_TEMPLATE = [
  "#!/bin/sh",
  "set +e",
  'PARENT_HOST="$(printf %s "CALLBACK_URL" | sed -E \'s|^[a-z]+://||; s|/.*$||; s|:.*$||\')"',
  'PARENT_PORT="$(printf %s "CALLBACK_URL" | sed -nE \'s|^[a-z]+://[^/]*:([0-9]+)/.*|\\1|p\')"',
  '[ -n "$PARENT_PORT" ] || PARENT_PORT=443',
  'case "CALLBACK_URL" in http://*) PARENT_PORT=80;; esac',
  "# Lock egress to the parent only (the result-POST destination).",
  "ufw --force enable >/dev/null 2>&1 || true",
  "ufw default deny outgoing >/dev/null 2>&1 || true",
  'ufw allow out to "$PARENT_HOST" port "$PARENT_PORT" proto tcp >/dev/null 2>&1 || true',
  "# Run the command (written verbatim via cloud-init write_files b64).",
  "START=$(date +%s%3N 2>/dev/null || date +%s)",
  "sh /tmp/sbx/command.sh >/tmp/sbx/out 2>/tmp/sbx/err",
  "EC=$?",
  "END=$(date +%s%3N 2>/dev/null || date +%s)",
  "EL=$((END-START))",
  "# Build JSON safely with python3 (preinstalled on debian-12).",
  'python3 - "$EC" "$EL" <<\'PY\' > /tmp/sbx/body.json',
  "import json, os, sys",
  "ec, el = sys.argv[1], sys.argv[2]",
  "out = open('/tmp/sbx/out').read() if os.path.exists('/tmp/sbx/out') else ''",
  "err = open('/tmp/sbx/err').read() if os.path.exists('/tmp/sbx/err') else ''",
  'print(json.dumps({"exit_code": int(ec), "stdout": out, "stderr": err, "elapsed_ms": int(el)}))',
  "PY",
  "# POST the result back to the parent — the only allowed egress.",
  'curl -sS -m 30 -X POST "CALLBACK_URL" -H "Authorization: Bearer AUTH_TOKEN" -H "Content-Type: application/json" --data @/tmp/sbx/body.json >/dev/null 2>&1 || true',
  "poweroff || true",
].join("\n");

/** Render cloud-init for a sandbox VM. The command is carried base64 so it never touches a shell. */
export function defaultCloudInit(ctx: CloudInitContext): string {
  const commandB64 = Buffer.from(ctx.command, "utf8").toString("base64");
  const agent = AGENT_TEMPLATE
    .split("CALLBACK_URL")
    .join(ctx.callbackUrl)
    .split("AUTH_TOKEN")
    .join(ctx.authToken);
  const agentB64 = Buffer.from(agent, "utf8").toString("base64");
  return [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - curl",
    "  - ufw",
    "write_files:",
    "  - path: /tmp/sbx/command.sh",
    "    encoding: b64",
    `    content: "${commandB64}"`,
    "    permissions: '0700'",
    "  - path: /tmp/sbx/agent.sh",
    "    encoding: b64",
    `    content: "${agentB64}"`,
    "    permissions: '0700'",
    "runcmd:",
    "  - sh /tmp/sbx/agent.sh",
    `final_message: "hetzner-exec sandbox runId=${ctx.runId} complete"`,
    "",
  ].join("\n");
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createCallbackRegistry(): CallbackRegistry {
  return new InMemoryCallbackRegistry();
}

export function createSandboxProvider(
  config: ServerConfig,
  runner: CommandRunner,
  callbacks: CallbackRegistry,
): SandboxProvider {
  if (config.sandboxProvider === "hcloud") {
    if (!config.hcloudToken) {
      throw new ConfigError("hcloud sandbox provider requires HETZNER_API_TOKEN");
    }
    if (!config.publicBaseUrl) {
      throw new ConfigError("hcloud sandbox provider requires HETZNER_EXEC_PUBLIC_URL (the server's reachable https URL)");
    }
    if (!config.authToken) {
      throw new ConfigError("hcloud sandbox provider requires HETZNER_EXEC_TOKEN (used to validate the result callback)");
    }
    const client = new HcloudHttpClient(config.hcloudToken);
    return new HcloudSandboxProvider({
      client,
      callbacks,
      cloudInit: defaultCloudInit,
      publicBaseUrl: config.publicBaseUrl,
      authToken: config.authToken,
      serverType: config.hcloudServerType,
      image: config.hcloudImage,
      location: config.hcloudLocation,
      sshKeyName: config.hcloudSshKeyName,
    });
  }
  return new DockerSandboxProvider(runner, config.defaultDockerImage);
}
