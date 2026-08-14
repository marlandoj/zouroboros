import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface ExternalComputeManifest {
  version: 1;
  commands: string[];
  verification?: "optional" | "remote-required";
  artifacts?: string[];
  excludes?: string[];
  server_type?: string;
  image?: string;
  location?: string;
  ttl_minutes?: number;
  max_cost_usd?: number;
}

export interface CommandResult {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
}

export interface EphemeralWorkerEvidence {
  version: 1;
  run_id: string;
  status: "passed" | "failed";
  server: {
    id: number;
    name: string;
    type: string;
    image: string;
    location: string;
  };
  limits: {
    ttl_minutes: number;
    max_cost_usd: number;
    hourly_cost_usd: number;
  };
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  estimated_cost_usd: number;
  commands: CommandResult[];
  artifact_archive: string | null;
  remote_environment?: { keys: string[] };
  teardown: {
    server_deleted: boolean;
    ssh_key_deleted: boolean;
  };
  error: string | null;
}

export interface WorkerRunOptions {
  workdir: string;
  manifest: ExternalComputeManifest;
  evidenceDir: string;
  env?: Record<string, string | undefined>;
  remoteEnv?: Record<string, string | undefined>;
  now?: () => Date;
  commandRunner?: CommandRunner;
}

export interface ReapResult {
  inspected: number;
  deleted: Array<{ id: number; name: string; expires_unix: number }>;
  retained: Array<{ id: number; name: string; expires_unix: number | null }>;
  ssh_keys_inspected: number;
  ssh_keys_deleted: Array<{ id: number; name: string; expires_unix: number }>;
  ssh_keys_retained: Array<{ id: number; name: string; expires_unix: number | null }>;
}

interface HcloudServer {
  id: number;
  name: string;
  public_net?: { ipv4?: { ip?: string } };
  labels?: Record<string, string>;
}

interface HcloudSshKey {
  id: number;
  name: string;
  labels?: Record<string, string>;
}

interface HcloudServerType {
  prices?: Array<{
    location: string;
    price_hourly?: { gross?: string; net?: string };
  }>;
}

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdinFile?: string;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  run(command: string, args: string[], options: SpawnOptions = {}): Promise<SpawnResult> {
    return new Promise((resolveResult, reject) => {
      const started = Date.now();
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv | undefined,
        stdio: [options.stdinFile ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);

      let timedOut = false;
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : null;

      if (options.stdinFile && child.stdin) {
        child.stdin.end(readFileSync(options.stdinFile));
      }

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolveResult({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
          elapsedMs: Date.now() - started,
        });
      });
    });
  }
}

const DEFAULT_SERVER_TYPE = "ccx33";
const DEFAULT_IMAGE = "ubuntu-24.04";
const DEFAULT_LOCATION = "hel1";
const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_MAX_COST_USD = 0.5;
const MAX_TTL_MINUTES = 120;
const MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "coverage", ".worktrees"];

function parseJsonOutput<T>(result: SpawnResult, operation: string): T {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function boundedOutput(value: string): string {
  return value.length <= MAX_OUTPUT_BYTES
    ? value
    : `${value.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

function validateRelativePath(path: string, field: string): void {
  if (
    !path.trim()
    || path.startsWith("/")
    || path.split("/").includes("..")
    || !/^[A-Za-z0-9._/@+-]+$/.test(path)
  ) {
    throw new Error(`${field} must contain safe relative paths`);
  }
}

export function validateManifest(input: unknown): ExternalComputeManifest {
  if (!input || typeof input !== "object") throw new Error("external compute manifest must be an object");
  const value = input as Partial<ExternalComputeManifest>;
  if (value.version !== 1) throw new Error("external compute manifest version must be 1");
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error("external compute manifest commands must be a non-empty string array");
  }
  if (value.commands.length > 20) throw new Error("external compute manifest supports at most 20 commands");
  if (value.verification !== undefined && value.verification !== "optional" && value.verification !== "remote-required") {
    throw new Error("verification must be optional or remote-required");
  }
  for (const path of value.artifacts ?? []) validateRelativePath(path, "artifacts");
  for (const path of value.excludes ?? []) validateRelativePath(path, "excludes");

  const ttl = value.ttl_minutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > MAX_TTL_MINUTES) {
    throw new Error(`ttl_minutes must be an integer between 5 and ${MAX_TTL_MINUTES}`);
  }
  const maxCost = value.max_cost_usd ?? DEFAULT_MAX_COST_USD;
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 5) {
    throw new Error("max_cost_usd must be greater than 0 and no more than 5");
  }
  return {
    version: 1,
    commands: [...value.commands],
    verification: value.verification ?? "optional",
    artifacts: [...(value.artifacts ?? [])],
    excludes: [...(value.excludes ?? [])],
    server_type: value.server_type?.trim() || DEFAULT_SERVER_TYPE,
    image: value.image?.trim() || DEFAULT_IMAGE,
    location: value.location?.trim() || DEFAULT_LOCATION,
    ttl_minutes: ttl,
    max_cost_usd: maxCost,
  };
}

export function loadManifest(path: string): ExternalComputeManifest {
  return validateManifest(JSON.parse(readFileSync(path, "utf8")));
}

export function estimateCostUsd(hourlyCostUsd: number, elapsedMs: number): number {
  return Number((hourlyCostUsd * (elapsedMs / 3_600_000)).toFixed(6));
}

function processEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, ...extra };
}

function validateRemoteEnv(input: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error("remoteEnv supports at most 32 variables");
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`remoteEnv key is invalid: ${key}`);
    if (typeof value !== "string" || value.length === 0) throw new Error(`remoteEnv value is required: ${key}`);
    if (Buffer.byteLength(value, "utf8") > 65_536) throw new Error(`remoteEnv value is too large: ${key}`);
    result[key] = value;
  }
  return result;
}

function remoteEnvScript(remoteEnv: Record<string, string>): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...Object.entries(remoteEnv).map(([key, value]) => {
      const encoded = Buffer.from(value, "utf8").toString("base64");
      return `export ${key}=$(printf '%s' '${encoded}' | base64 --decode)`;
    }),
    "",
  ].join("\n");
}

async function requireOk(runner: CommandRunner, command: string, args: string[], operation: string, options: SpawnOptions = {}): Promise<SpawnResult> {
  const result = await runner.run(command, args, options);
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

async function waitForSsh(
  runner: CommandRunner,
  keyPath: string,
  ip: string,
  deadlineMs: number,
  env: Record<string, string | undefined>,
): Promise<void> {
  while (Date.now() < deadlineMs) {
    const result = await runner.run("ssh", sshArgs(keyPath, ip, ["true"]), { env, timeoutMs: 15_000 });
    if (result.exitCode === 0) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5_000));
  }
  throw new Error("worker did not become reachable over SSH before the TTL deadline");
}

async function waitForBootstrap(
  runner: CommandRunner,
  keyPath: string,
  ip: string,
  deadlineMs: number,
  env: Record<string, string | undefined>,
): Promise<void> {
  while (Date.now() < deadlineMs) {
    const result = await runner.run(
      "ssh",
      sshArgs(keyPath, ip, ["test", "-f", "/var/lib/zouroboros-worker-ready"]),
      { env, timeoutMs: 15_000 },
    );
    if (result.exitCode === 0) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5_000));
  }
  throw new Error("worker bootstrap did not finish before the TTL deadline");
}

function sshArgs(keyPath: string, ip: string, remoteArgs: string[]): string[] {
  return [
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    `root@${ip}`,
    ...remoteArgs,
  ];
}

function scpArgs(keyPath: string): string[] {
  return [
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
  ];
}

function cloudInit(): string {
  const bootstrap = Buffer.from([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "curl -fsSL https://bun.sh/install -o /tmp/install-bun.sh",
    "env BUN_INSTALL=/usr/local bash /tmp/install-bun.sh",
    "test -x /usr/local/bin/bun",
    "touch /var/lib/zouroboros-worker-ready",
    "",
  ].join("\n"), "utf8").toString("base64");
  return [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - ca-certificates",
    "  - curl",
    "  - git",
    "  - build-essential",
    "  - unzip",
    "write_files:",
    "  - path: /tmp/zouroboros-bootstrap.sh",
    "    encoding: b64",
    `    content: "${bootstrap}"`,
    "    permissions: '0700'",
    "runcmd:",
    "  - bash /tmp/zouroboros-bootstrap.sh",
    "",
  ].join("\n");
}

async function getHourlyCost(
  runner: CommandRunner,
  serverType: string,
  location: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const result = await runner.run("hcloud", ["server-type", "describe", serverType, "-o", "json"], { env, timeoutMs: 30_000 });
  const type = parseJsonOutput<HcloudServerType>(result, `describe server type ${serverType}`);
  const price = type.prices?.find((entry) => entry.location === location)?.price_hourly;
  const raw = price?.gross ?? price?.net;
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`hourly price unavailable for ${serverType} in ${location}`);
  return value;
}

async function createSourceArchive(
  runner: CommandRunner,
  workdir: string,
  target: string,
  excludes: string[],
): Promise<void> {
  const args = [
    ...excludes.flatMap((path) => ["--exclude", path]),
    "-czf", target,
    "-C", workdir,
    ".",
  ];
  await requireOk(runner, "tar", args, "create source archive", { timeoutMs: 10 * 60_000 });
}

async function retrieveArtifacts(
  runner: CommandRunner,
  keyPath: string,
  ip: string,
  artifacts: string[],
  evidenceDir: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (artifacts.length === 0) return null;
  const remoteArchive = "/tmp/zouroboros-artifacts.tgz";
  const tarArgs = ["tar", "-czf", remoteArchive, "-C", "/opt/zouroboros-job", "--", ...artifacts];
  await requireOk(runner, "ssh", sshArgs(keyPath, ip, tarArgs), "archive worker artifacts", { env, timeoutMs: 5 * 60_000 });
  const localArchive = join(evidenceDir, "artifacts.tgz");
  await requireOk(
    runner,
    "scp",
    [...scpArgs(keyPath), `root@${ip}:${remoteArchive}`, localArchive],
    "retrieve worker artifacts",
    { env, timeoutMs: 5 * 60_000 },
  );
  return localArchive;
}

export async function runEphemeralWorker(options: WorkerRunOptions): Promise<EphemeralWorkerEvidence> {
  const manifest = validateManifest(options.manifest);
  const runner = options.commandRunner ?? new ProcessCommandRunner();
  const env = processEnv(options.env);
  const remoteEnv = validateRemoteEnv(options.remoteEnv ?? {});
  if (!(env.HCLOUD_TOKEN ?? env.HETZNER_API_TOKEN)) throw new Error("HCLOUD_TOKEN is required");
  if (!env.HCLOUD_TOKEN && env.HETZNER_API_TOKEN) env.HCLOUD_TOKEN = env.HETZNER_API_TOKEN;

  const workdir = resolve(options.workdir);
  const evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const now = options.now ?? (() => new Date());
  const started = now();
  const runId = `factory-${randomUUID().slice(0, 12)}`;
  const serverName = `zbr-${runId}`;
  const sshKeyName = `${serverName}-key`;
  const ttlMinutes = manifest.ttl_minutes ?? DEFAULT_TTL_MINUTES;
  const maxCostUsd = manifest.max_cost_usd ?? DEFAULT_MAX_COST_USD;
  const deadlineMs = started.getTime() + ttlMinutes * 60_000;
  const expiresUnix = Math.floor(deadlineMs / 1000);
  const hourlyCostUsd = await getHourlyCost(runner, manifest.server_type!, manifest.location!, env);
  const ttlCostUsd = hourlyCostUsd * (ttlMinutes / 60);
  if (ttlCostUsd > maxCostUsd) {
    throw new Error(`TTL cost $${ttlCostUsd.toFixed(4)} exceeds max_cost_usd $${maxCostUsd.toFixed(4)}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "zbr-worker-"));
  const keyPath = join(scratch, "id_ed25519");
  const sourceArchive = join(scratch, "source.tgz");
  const cloudInitPath = join(scratch, "cloud-init.yaml");
  const commandScriptPath = join(scratch, "command.sh");
  const remoteEnvPath = join(scratch, "remote-env.sh");
  const commandResults: CommandResult[] = [];
  let server: HcloudServer | null = null;
  let sshKey: HcloudSshKey | null = null;
  let artifactArchive: string | null = null;
  let error: string | null = null;
  let serverDeleted = false;
  let sshKeyDeleted = false;

  try {
    await requireOk(runner, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], "generate ephemeral SSH key");
    const keyCreate = await runner.run(
      "hcloud",
      [
        "ssh-key", "create",
        "--name", sshKeyName,
        "--public-key-from-file", `${keyPath}.pub`,
        "--label", "zouroboros_worker=ephemeral",
        "--label", `expires_unix=${expiresUnix}`,
        "--label", `run_id=${runId}`,
        "-o", "json",
      ],
      { env, timeoutMs: 30_000 },
    );
    sshKey = parseJsonOutput<{ ssh_key: HcloudSshKey }>(keyCreate, "create ephemeral SSH key").ssh_key;
    if (!sshKey?.id || !sshKey.name) throw new Error("create ephemeral SSH key returned an incomplete key record");
    writeFileSync(cloudInitPath, cloudInit());
    await createSourceArchive(runner, workdir, sourceArchive, [...DEFAULT_EXCLUDES, ...(manifest.excludes ?? [])]);

    const create = await runner.run("hcloud", [
      "server", "create",
      "--name", serverName,
      "--type", manifest.server_type!,
      "--image", manifest.image!,
      "--location", manifest.location!,
      "--ssh-key", sshKey.name,
      "--user-data-from-file", cloudInitPath,
      "--label", "zouroboros_worker=ephemeral",
      "--label", `expires_unix=${expiresUnix}`,
      "--label", `run_id=${runId}`,
      "-o", "json",
    ], { env, timeoutMs: 60_000 });
    server = parseJsonOutput<{ server: HcloudServer }>(create, "create ephemeral worker").server;
    const ip = server.public_net?.ipv4?.ip;
    if (!ip) throw new Error("created worker has no public IPv4 address");

    await waitForSsh(runner, keyPath, ip, deadlineMs, env);
    await waitForBootstrap(runner, keyPath, ip, deadlineMs, env);
    await requireOk(
      runner,
      "scp",
      [...scpArgs(keyPath), sourceArchive, `root@${ip}:/tmp/source.tgz`],
      "upload source archive",
      { env, timeoutMs: Math.max(1_000, Math.min(10 * 60_000, deadlineMs - Date.now())) },
    );
    await requireOk(
      runner,
      "ssh",
      sshArgs(keyPath, ip, ["mkdir", "-p", "/opt/zouroboros-job"]),
      "create remote job directory",
      { env, timeoutMs: Math.max(1_000, Math.min(5 * 60_000, deadlineMs - Date.now())) },
    );
    await requireOk(
      runner,
      "ssh",
      sshArgs(keyPath, ip, ["tar", "-xzf", "/tmp/source.tgz", "-C", "/opt/zouroboros-job"]),
      "extract source archive",
      { env, timeoutMs: Math.max(1_000, Math.min(5 * 60_000, deadlineMs - Date.now())) },
    );
    if (Object.keys(remoteEnv).length > 0) {
      writeFileSync(remoteEnvPath, remoteEnvScript(remoteEnv), { mode: 0o600 });
      await requireOk(
        runner,
        "scp",
        [...scpArgs(keyPath), remoteEnvPath, `root@${ip}:/tmp/zouroboros-env.sh`],
        "upload worker environment",
        { env, timeoutMs: Math.max(1_000, Math.min(60_000, deadlineMs - Date.now())) },
      );
      await requireOk(
        runner,
        "ssh",
        sshArgs(keyPath, ip, ["chmod", "0600", "/tmp/zouroboros-env.sh"]),
        "protect worker environment",
        { env, timeoutMs: Math.max(1_000, Math.min(30_000, deadlineMs - Date.now())) },
      );
    }

    for (const command of manifest.commands) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) throw new Error("worker TTL exhausted before all commands completed");
      writeFileSync(commandScriptPath, [
        "#!/usr/bin/env bash",
        "set -o pipefail",
        "export PATH=/root/.bun/bin:$PATH",
        Object.keys(remoteEnv).length > 0 ? "source /tmp/zouroboros-env.sh" : "",
        "cd /opt/zouroboros-job",
        command,
        "",
      ].join("\n"));
      await requireOk(
        runner,
        "scp",
        [...scpArgs(keyPath), commandScriptPath, `root@${ip}:/tmp/zouroboros-command.sh`],
        "upload worker command",
        { env, timeoutMs: Math.max(1_000, Math.min(60_000, remaining)) },
      );
      const result = await runner.run(
        "ssh",
        sshArgs(keyPath, ip, ["bash", "/tmp/zouroboros-command.sh"]),
        { env, timeoutMs: remaining },
      );
      commandResults.push({
        command,
        exit_code: result.exitCode,
        stdout: boundedOutput(result.stdout),
        stderr: boundedOutput(result.stderr),
        elapsed_ms: result.elapsedMs,
        timed_out: result.timedOut,
      });
      if (result.exitCode !== 0) {
        error = `command failed (${result.exitCode}): ${command}`;
        break;
      }
    }
    if (!error) {
      artifactArchive = await retrieveArtifacts(runner, keyPath, ip, manifest.artifacts ?? [], evidenceDir, env);
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (server) {
      const deleted = await runner.run("hcloud", ["server", "delete", String(server.id)], { env, timeoutMs: 30_000 });
      serverDeleted = deleted.exitCode === 0;
    }
    if (sshKey) {
      const deleted = await runner.run("hcloud", ["ssh-key", "delete", String(sshKey.id)], { env, timeoutMs: 30_000 });
      sshKeyDeleted = deleted.exitCode === 0;
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  const completed = now();
  const elapsedMs = Math.max(0, completed.getTime() - started.getTime());
  const evidence: EphemeralWorkerEvidence = {
    version: 1,
    run_id: runId,
    status: !error && commandResults.length === manifest.commands.length && commandResults.every((r) => r.exit_code === 0) ? "passed" : "failed",
    server: {
      id: server?.id ?? 0,
      name: server?.name ?? serverName,
      type: manifest.server_type!,
      image: manifest.image!,
      location: manifest.location!,
    },
    limits: {
      ttl_minutes: ttlMinutes,
      max_cost_usd: maxCostUsd,
      hourly_cost_usd: hourlyCostUsd,
    },
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    elapsed_ms: elapsedMs,
    estimated_cost_usd: estimateCostUsd(hourlyCostUsd, elapsedMs),
    commands: commandResults,
    artifact_archive: artifactArchive,
    remote_environment: { keys: Object.keys(remoteEnv).sort() },
    teardown: {
      server_deleted: serverDeleted,
      ssh_key_deleted: sshKeyDeleted,
    },
    error,
  };
  writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function reapExpiredWorkers(options: {
  env?: Record<string, string | undefined>;
  nowUnix?: number;
  dryRun?: boolean;
  commandRunner?: CommandRunner;
} = {}): Promise<ReapResult> {
  const runner = options.commandRunner ?? new ProcessCommandRunner();
  const env = processEnv(options.env);
  if (!env.HCLOUD_TOKEN && env.HETZNER_API_TOKEN) env.HCLOUD_TOKEN = env.HETZNER_API_TOKEN;
  if (!env.HCLOUD_TOKEN) throw new Error("HCLOUD_TOKEN is required");
  const listed = await runner.run(
    "hcloud",
    ["server", "list", "-l", "zouroboros_worker=ephemeral", "-o", "json"],
    { env, timeoutMs: 30_000 },
  );
  const servers = parseJsonOutput<HcloudServer[]>(listed, "list ephemeral workers");
  const keysListed = await runner.run(
    "hcloud",
    ["ssh-key", "list", "-l", "zouroboros_worker=ephemeral", "-o", "json"],
    { env, timeoutMs: 30_000 },
  );
  const sshKeys = parseJsonOutput<HcloudSshKey[]>(keysListed, "list ephemeral worker SSH keys");
  const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const result: ReapResult = {
    inspected: servers.length,
    deleted: [],
    retained: [],
    ssh_keys_inspected: sshKeys.length,
    ssh_keys_deleted: [],
    ssh_keys_retained: [],
  };
  for (const server of servers) {
    const raw = server.labels?.expires_unix;
    const expiresUnix = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(expiresUnix) && expiresUnix <= nowUnix) {
      if (!options.dryRun) {
        await requireOk(runner, "hcloud", ["server", "delete", String(server.id)], `delete expired worker ${server.id}`, { env, timeoutMs: 30_000 });
      }
      result.deleted.push({ id: server.id, name: server.name, expires_unix: expiresUnix });
    } else {
      result.retained.push({ id: server.id, name: server.name, expires_unix: Number.isFinite(expiresUnix) ? expiresUnix : null });
    }
  }
  for (const sshKey of sshKeys) {
    const raw = sshKey.labels?.expires_unix;
    const expiresUnix = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(expiresUnix) && expiresUnix <= nowUnix) {
      if (!options.dryRun) {
        await requireOk(runner, "hcloud", ["ssh-key", "delete", String(sshKey.id)], `delete expired worker SSH key ${sshKey.id}`, { env, timeoutMs: 30_000 });
      }
      result.ssh_keys_deleted.push({ id: sshKey.id, name: sshKey.name, expires_unix: expiresUnix });
    } else {
      result.ssh_keys_retained.push({ id: sshKey.id, name: sshKey.name, expires_unix: Number.isFinite(expiresUnix) ? expiresUnix : null });
    }
  }
  return result;
}

export function defaultEvidenceDir(workdir: string, runLabel: string): string {
  return join(workdir, "evaluations", "external-compute", basename(runLabel));
}
