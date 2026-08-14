import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FalkorDB, type Graph } from "falkordblite";

export const REDIS_VERSION = "8.2.3";
export const REDIS_SOURCE_URL = `https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz`;
export const REDIS_SOURCE_SHA256 = "42d4d3f037db92eea4437ba03f87627cd636ed15a1f2dde7af9650aa94b035d8";
export const FALKORDB_MODULE_SHA256 = "7e9e39ce69780fbae2cf7a31c28e05a51b4e9177b73e755384de0c3cf9f812e5";

interface RuntimeReceipt {
  version: 1;
  redis_version: string;
  source_url: string;
  source_sha256: string;
  binary_sha256: string;
  built_at: string;
}

export interface EmbeddedGraphOptions {
  path: string;
  graphName?: string;
  cacheDir?: string;
  redisServerPath?: string;
  modulePath?: string;
  timeoutMs?: number;
}

export interface EmbeddedGraphSession {
  graph: Graph;
  redisServerPath: string;
  modulePath: string;
  pid: number | undefined;
  socketPath: string;
  close(): Promise<void>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

function validateExecutable(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Redis server not found: ${resolved}`);
  return resolved;
}

function resolveModulePath(override?: string): string {
  const path = override
    ? resolve(override)
    : resolve(dirname(fileURLToPath(import.meta.resolve("@falkordblite/linux-x64"))), "bin/falkordb.so");
  if (!existsSync(path)) throw new Error(`FalkorDB module not found: ${path}`);
  const digest = sha256File(path);
  if (digest !== FALKORDB_MODULE_SHA256) {
    throw new Error(`FalkorDB module checksum mismatch: expected ${FALKORDB_MODULE_SHA256}, got ${digest}`);
  }
  return path;
}

function readValidReceipt(binaryPath: string, receiptPath: string): RuntimeReceipt | null {
  if (!existsSync(binaryPath) || !existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RuntimeReceipt;
    if (
      receipt.version !== 1 ||
      receipt.redis_version !== REDIS_VERSION ||
      receipt.source_sha256 !== REDIS_SOURCE_SHA256 ||
      receipt.binary_sha256 !== sha256File(binaryPath)
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

async function waitForConcurrentBuild(binaryPath: string, receiptPath: string, lockPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (readValidReceipt(binaryPath, receiptPath)) return binaryPath;
    if (!existsSync(lockPath)) return null;
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for Redis ${REDIS_VERSION} build lock`);
}

export async function ensureRedisServer(options: Pick<EmbeddedGraphOptions, "cacheDir" | "redisServerPath"> = {}): Promise<string> {
  if (options.redisServerPath) return validateExecutable(options.redisServerPath);
  if (process.env.FALKORDBLITE_REDIS_SERVER) return validateExecutable(process.env.FALKORDBLITE_REDIS_SERVER);

  const cacheDir = resolve(options.cacheDir ?? join(homedir(), ".cache", "zouroboros", "falkordblite"));
  const binaryPath = join(cacheDir, `redis-server-${REDIS_VERSION}`);
  const receiptPath = `${binaryPath}.receipt.json`;
  const lockPath = `${binaryPath}.lock`;
  if (readValidReceipt(binaryPath, receiptPath)) return binaryPath;

  mkdirSync(cacheDir, { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = await waitForConcurrentBuild(binaryPath, receiptPath, lockPath);
    if (concurrent) return concurrent;
    mkdirSync(lockPath);
  }

  const buildRoot = mkdtempSync(join(tmpdir(), "zouroboros-redis-build-"));
  const archivePath = join(buildRoot, `redis-${REDIS_VERSION}.tar.gz`);
  const stagedBinary = `${binaryPath}.tmp-${process.pid}`;
  const stagedReceipt = `${receiptPath}.tmp-${process.pid}`;
  try {
    const response = await fetch(REDIS_SOURCE_URL);
    if (!response.ok) throw new Error(`Redis source download failed: HTTP ${response.status}`);
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    const sourceDigest = sha256File(archivePath);
    if (sourceDigest !== REDIS_SOURCE_SHA256) {
      throw new Error(`Redis source checksum mismatch: expected ${REDIS_SOURCE_SHA256}, got ${sourceDigest}`);
    }
    await run("tar", ["-xzf", archivePath, "-C", buildRoot]);
    const sourceDir = join(buildRoot, `redis-${REDIS_VERSION}`);
    await run("make", ["-j2", "BUILD_TLS=no", "MALLOC=libc"], sourceDir);
    const builtBinary = join(sourceDir, "src", "redis-server");
    if (!existsSync(builtBinary)) throw new Error("Redis build completed without redis-server");
    copyFileSync(builtBinary, stagedBinary);
    chmodSync(stagedBinary, 0o755);
    const receipt: RuntimeReceipt = {
      version: 1,
      redis_version: REDIS_VERSION,
      source_url: REDIS_SOURCE_URL,
      source_sha256: REDIS_SOURCE_SHA256,
      binary_sha256: sha256File(stagedBinary),
      built_at: new Date().toISOString(),
    };
    writeFileSync(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(stagedBinary, binaryPath);
    renameSync(stagedReceipt, receiptPath);
    return binaryPath;
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(stagedBinary, { force: true });
    rmSync(stagedReceipt, { force: true });
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export async function openEmbeddedGraph(options: EmbeddedGraphOptions): Promise<EmbeddedGraphSession> {
  const redisServerPath = await ensureRedisServer(options);
  const modulePath = resolveModulePath(options.modulePath);
  const database = await FalkorDB.open({
    path: resolve(options.path),
    redisServerPath,
    modulePath,
    timeout: options.timeoutMs ?? 20_000,
    logLevel: "warning",
  });
  const graph = database.selectGraph(options.graphName ?? "zouroboros");
  return {
    graph,
    redisServerPath,
    modulePath,
    pid: database.pid,
    socketPath: database.socketPath,
    close: () => database.close(),
  };
}
