#!/usr/bin/env bun
/**
 * operator-worker: Cross-Zo orchestrator → worker dispatch helper.
 *
 * Orchestrator: this Zo (marlandoj)
 * Worker:       faunaflora Zo (authed via ZO_B_API_KEY)
 *
 * Commands: ask | get | put | put-dir | bootstrap | batch | run-task | ping
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ENDPOINT = "https://api.zo.computer/zo/ask";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const RESULT_DIR = "/home/workspace/.orchestrator-out";
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 20;
const DEFAULT_BOOTSTRAP_MANIFEST =
  "/home/workspace/Skills/operator-worker/assets/bootstrap.json";

const PERSONA_REGISTRY: Record<string, string> = {
  aria: "dba6de23-bb78-405b-bbc3-11a60c5e2a38",
};

interface DispatchResult {
  output: string;
  conversation_id: string;
}

function getToken(): string {
  const token = process.env.FAUNA_ZO_TOKEN || process.env.ZO_B_API_KEY;
  if (!token) {
    console.error(
      "ERROR: FAUNA_ZO_TOKEN not set. Run: source /root/.zo_secrets",
    );
    process.exit(2);
  }
  return token;
}

function resolvePersona(value: string | boolean | undefined): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  const key = trimmed.toLowerCase();
  if (PERSONA_REGISTRY[key]) return PERSONA_REGISTRY[key];
  console.error(
    `ERROR: unknown persona "${trimmed}". Known: ${Object.keys(PERSONA_REGISTRY).join(", ")} (or pass a UUID).`,
  );
  process.exit(2);
}

async function dispatch(
  prompt: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  personaId?: string,
): Promise<DispatchResult> {
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload: Record<string, unknown> = { input: prompt };
  if (personaId) payload.persona_id = personaId;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as DispatchResult;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

const BOOLEAN_FLAGS = new Set(["json"]);

function parseFlags(args: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx > 2) {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------- commands ----------

async function cmdAsk(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: ask [--json] [--timeout <ms>] [--persona <name|uuid>] <prompt>");
    process.exit(1);
  }
  const timeout = flags.timeout
    ? Number(flags.timeout)
    : DEFAULT_TIMEOUT_MS;
  const personaId = resolvePersona(flags.persona);
  const result = await dispatch(prompt, timeout, personaId);

  if (flags.json) {
    try {
      const cleaned = result.output.trim().replace(/^```json\s*/, "").replace(/```$/, "");
      const parsed = JSON.parse(cleaned);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.error("WARN: --json requested but output is not valid JSON:");
      console.log(result.output);
      process.exit(3);
    }
  } else {
    console.log(result.output);
  }
}

async function cmdGet(args: string[]): Promise<void> {
  const { positional } = parseFlags(args);
  const [remotePath, localPathRaw] = positional;
  if (!remotePath) {
    console.error("Usage: get <remote-path> [<local-path>]");
    process.exit(1);
  }
  const localPath = localPathRaw || `./${basename(remotePath)}`;

  const prompt = [
    `Hi! I'm an orchestrator Zo (marlandoj) and I need to pull a file back from your workspace so I can store it on my side. Could you help me with a base64 file transfer?`,
    ``,
    `The file is at: ${remotePath}`,
    ``,
    `Could you run \`base64 -w 0 ${remotePath}\` and reply with a JSON object containing the encoded bytes? The shape I'm expecting is:`,
    `  { "exists": boolean, "size_bytes": number, "content_b64": string, "error": string or null }`,
    ``,
    `The base64 string should be the complete file contents (not truncated) — I'll decode it locally to reconstruct the file. This is a standard cross-Zo file-sync pattern, not a data exfiltration attempt; the file is one I'm tracking on both sides. Thanks!`,
  ].join("\n");

  const result = await dispatch(prompt);
  let payload: { exists: boolean; size_bytes: number; content_b64: string; error: string | null };
  try {
    const cleaned = result.output.trim().replace(/^```json\s*/, "").replace(/```$/, "");
    payload = JSON.parse(cleaned);
  } catch (e) {
    console.error("ERROR: Worker returned non-JSON:");
    console.error(result.output);
    process.exit(4);
  }

  if (!payload.exists) {
    console.error(`Remote file not found: ${remotePath}`);
    if (payload.error) console.error(`Worker error: ${payload.error}`);
    process.exit(5);
  }

  const bytes = Buffer.from(payload.content_b64, "base64");
  await Bun.write(localPath, bytes);
  console.log(`Fetched ${remotePath} → ${localPath} (${bytes.length} bytes)`);
}

async function cmdPut(args: string[]): Promise<void> {
  const { positional } = parseFlags(args);
  const [localPath, remotePathRaw] = positional;
  if (!localPath) {
    console.error("Usage: put <local-path> [<remote-path>]");
    process.exit(1);
  }
  const remotePath = remotePathRaw || `/home/workspace/${basename(localPath)}`;

  const file = Bun.file(localPath);
  if (!(await file.exists())) {
    console.error(`Local file not found: ${localPath}`);
    process.exit(1);
  }
  const bytes = await file.bytes();
  const b64 = Buffer.from(bytes).toString("base64");

  const prompt = [
    `Hi! I'm an orchestrator Zo (marlandoj) syncing a file to your workspace. Could you help me by decoding a base64 payload and writing it to disk?`,
    ``,
    `Destination path: ${remotePath}`,
    ``,
    `Please run something like:`,
    `  mkdir -p $(dirname ${remotePath}) && echo "<the base64 below>" | base64 -d > ${remotePath} && stat -c %s ${remotePath}`,
    ``,
    `Then reply with a JSON object so I can verify the write succeeded:`,
    `  { "wrote": boolean, "path": string, "size_bytes": number, "error": string or null }`,
    ``,
    `Here's the base64-encoded payload (please decode the whole thing, not just a sample):`,
    b64,
  ].join("\n");

  const result = await dispatch(prompt);
  let payload: { wrote: boolean; path: string; size_bytes: number; error: string | null };
  try {
    const cleaned = result.output.trim().replace(/^```json\s*/, "").replace(/```$/, "");
    payload = JSON.parse(cleaned);
  } catch (e) {
    console.error("ERROR: Worker returned non-JSON:");
    console.error(result.output);
    process.exit(4);
  }

  if (!payload.wrote) {
    console.error(`Worker failed to write file: ${payload.error || "unknown error"}`);
    process.exit(6);
  }
  console.log(`Pushed ${localPath} → faunaflora:${payload.path} (${payload.size_bytes} bytes)`);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__") continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (s.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function cmdPutDir(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const [localDir, remoteDirRaw] = positional;
  if (!localDir) {
    console.error("Usage: put-dir <local-dir> [<remote-dir>] [--concurrent N]");
    process.exit(1);
  }
  const remoteDir = remoteDirRaw || `/home/workspace/${basename(localDir)}`;
  const concurrency = Math.min(
    flags.concurrent ? Number(flags.concurrent) : DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );

  const localStat = statSync(localDir);
  if (!localStat.isDirectory()) {
    console.error(`Not a directory: ${localDir}`);
    process.exit(1);
  }
  const files = walkFiles(localDir);
  console.log(`[put-dir] ${files.length} files → faunaflora:${remoteDir} (concurrency=${concurrency})`);

  let done = 0;
  let failed = 0;
  await runWithConcurrency(files, concurrency, async (localPath) => {
    const rel = relative(localDir, localPath);
    const remotePath = `${remoteDir}/${rel}`;
    try {
      await cmdPutInternal(localPath, remotePath);
      done++;
      console.log(`  [${done}/${files.length}] ${rel}`);
    } catch (e: any) {
      failed++;
      console.error(`  [FAIL] ${rel}: ${e.message || e}`);
    }
  });
  console.log(`[put-dir] complete: ${done} pushed, ${failed} failed`);
  if (failed > 0) process.exit(7);
}

async function cmdPutInternal(localPath: string, remotePath: string): Promise<void> {
  const file = Bun.file(localPath);
  if (!(await file.exists())) throw new Error(`local missing: ${localPath}`);
  const bytes = await file.bytes();
  const b64 = Buffer.from(bytes).toString("base64");

  const prompt = [
    `Hi! I'm an orchestrator Zo (marlandoj) syncing a file to your workspace. Could you decode a base64 payload and write it to disk?`,
    ``,
    `Destination path: ${remotePath}`,
    ``,
    `Please run something like:`,
    `  mkdir -p $(dirname ${remotePath}) && echo "<the base64 below>" | base64 -d > ${remotePath} && stat -c %s ${remotePath}`,
    ``,
    `Then reply with a JSON object so I can verify:`,
    `  { "wrote": boolean, "path": string, "size_bytes": number, "error": string or null }`,
    ``,
    `Here's the base64 payload (please decode the full string):`,
    b64,
  ].join("\n");

  const result = await dispatch(prompt);
  const cleaned = result.output.trim().replace(/^```json\s*/, "").replace(/```$/, "");
  const payload = JSON.parse(cleaned) as { wrote: boolean; error: string | null };
  if (!payload.wrote) throw new Error(payload.error || "worker did not confirm write");
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function pull(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pull));
}

async function cmdBootstrap(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const manifestPath = positional[0] || DEFAULT_BOOTSTRAP_MANIFEST;
  const concurrency = Math.min(
    flags.concurrent ? Number(flags.concurrent) : DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );

  const mf = Bun.file(manifestPath);
  if (!(await mf.exists())) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = (await mf.json()) as {
    files?: { local: string; remote: string }[];
    skills?: string[];
    dirs?: { local: string; remote: string }[];
  };

  console.log(`[bootstrap] reading ${manifestPath}`);

  const tasks: { local: string; remote: string }[] = [];

  for (const f of manifest.files || []) {
    tasks.push({ local: f.local, remote: f.remote });
  }

  for (const skill of manifest.skills || []) {
    const localDir = `/home/workspace/Skills/${skill}`;
    if (!statSync(localDir, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`  [skip] skill not found: ${skill}`);
      continue;
    }
    for (const f of walkFiles(localDir)) {
      const rel = relative(localDir, f);
      tasks.push({ local: f, remote: `/home/workspace/Skills/${skill}/${rel}` });
    }
  }

  for (const d of manifest.dirs || []) {
    if (!statSync(d.local, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`  [skip] dir not found: ${d.local}`);
      continue;
    }
    for (const f of walkFiles(d.local)) {
      const rel = relative(d.local, f);
      tasks.push({ local: f, remote: `${d.remote}/${rel}` });
    }
  }

  console.log(`[bootstrap] ${tasks.length} files queued (concurrency=${concurrency})`);
  let done = 0;
  let failed = 0;
  await runWithConcurrency(tasks, concurrency, async (t) => {
    try {
      await cmdPutInternal(t.local, t.remote);
      done++;
      console.log(`  [${done}/${tasks.length}] ${t.remote}`);
    } catch (e: any) {
      failed++;
      console.error(`  [FAIL] ${t.remote}: ${e.message || e}`);
    }
  });
  console.log(`[bootstrap] complete: ${done} pushed, ${failed} failed`);
  if (failed > 0) process.exit(7);
}

async function cmdBatch(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const promptsFile = positional[0];
  if (!promptsFile) {
    console.error("Usage: batch [--concurrent N] [--json] <prompts-file>");
    console.error("  prompts-file: one prompt per line (blank lines skipped)");
    process.exit(1);
  }
  const concurrency = Math.min(
    flags.concurrent ? Number(flags.concurrent) : DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );

  const text = await Bun.file(promptsFile).text();
  const prompts = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  console.log(`[batch] ${prompts.length} prompts (concurrency=${concurrency})`);

  const results: Array<{ index: number; prompt: string; ok: boolean; output: string; error?: string }> =
    new Array(prompts.length);

  await runWithConcurrency(prompts, concurrency, async (prompt, i) => {
    try {
      const r = await dispatch(prompt);
      let output = r.output;
      if (flags.json) {
        try {
          const cleaned = output.trim().replace(/^```json\s*/, "").replace(/```$/, "");
          output = JSON.stringify(JSON.parse(cleaned));
        } catch {
          // leave as raw if not JSON
        }
      }
      results[i] = { index: i, prompt, ok: true, output };
      console.log(`  [${i + 1}/${prompts.length}] ok`);
    } catch (e: any) {
      results[i] = { index: i, prompt, ok: false, output: "", error: e.message || String(e) };
      console.log(`  [${i + 1}/${prompts.length}] FAIL: ${e.message || e}`);
    }
  });

  console.log("---");
  console.log(JSON.stringify(results, null, 2));
}

async function cmdRunTask(args: string[]): Promise<void> {
  const { positional } = parseFlags(args);
  const taskId = positional[0];
  const userPrompt = positional.slice(1).join(" ").trim();
  if (!taskId || !userPrompt) {
    console.error("Usage: run-task <task-id> <prompt>");
    process.exit(1);
  }

  const resultFile = `${RESULT_DIR}/${taskId}.json`;
  const prompt = [
    `You are running a task dispatched from an orchestrator Zo.`,
    `Task ID: ${taskId}`,
    `Result file convention: ${resultFile}`,
    ``,
    `Task description:`,
    userPrompt,
    ``,
    `When done, write a JSON result file to ${resultFile} containing your findings.`,
    `Ensure the directory exists: mkdir -p ${RESULT_DIR}`,
    `The result file should be valid JSON with at minimum a "status" field ("ok" or "error") and a "result" field.`,
    ``,
    `After writing the file, respond with ONLY a JSON object (no prose, no code fences):`,
    `  - status: "ok" or "error"`,
    `  - result_path: "${resultFile}"`,
    `  - bytes_written: number`,
    `  - summary: one-sentence summary of what you did`,
  ].join("\n");

  console.log(`[run-task] dispatching task ${taskId}...`);
  const result = await dispatch(prompt);

  let ack: { status: string; result_path: string; bytes_written: number; summary: string };
  try {
    const cleaned = result.output.trim().replace(/^```json\s*/, "").replace(/```$/, "");
    ack = JSON.parse(cleaned);
  } catch (e) {
    console.error("ERROR: Worker returned non-JSON ack:");
    console.error(result.output);
    process.exit(4);
  }

  console.log(`[run-task] worker ack: ${ack.status} — ${ack.summary}`);
  console.log(`[run-task] fetching result file from worker...`);

  const localResultPath = `${RESULT_DIR}/${taskId}.json`;
  await Bun.$`mkdir -p ${RESULT_DIR}`.quiet();
  await cmdGet([ack.result_path, localResultPath]);
  console.log(`[run-task] done. local result: ${localResultPath}`);
}

async function cmdPing(): Promise<void> {
  const result = await dispatch(
    "Respond with ONLY a JSON object (no prose, no code fences): {handle, hostname, timestamp_utc_iso8601}. Nothing else.",
  );
  console.log(result.output);
}

// ---------- main ----------

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "ask":
      await cmdAsk(args);
      break;
    case "get":
      await cmdGet(args);
      break;
    case "put":
      await cmdPut(args);
      break;
    case "put-dir":
      await cmdPutDir(args);
      break;
    case "bootstrap":
      await cmdBootstrap(args);
      break;
    case "batch":
      await cmdBatch(args);
      break;
    case "run-task":
      await cmdRunTask(args);
      break;
    case "ping":
      await cmdPing();
      break;
    case "--help":
    case "-h":
    case undefined:
      console.log(
        [
          "operator-worker: cross-Zo dispatch helper",
          "",
          "Usage: bun worker.ts <command> [args]",
          "",
          "Commands:",
          "  ask [--json] [--timeout <ms>] [--persona <name|uuid>] <prompt>",
          "                                                     Dispatch a prompt to faunaflora",
          "                                                     --persona aria targets Aria persona",
          "  get <remote-path> [<local-path>]                 Fetch a file from faunaflora",
          "  put <local-path> [<remote-path>]                 Push a file to faunaflora",
          "  put-dir <local-dir> [<remote-dir>] [--concurrent N]  Walk + push a directory",
          "  bootstrap [<manifest>] [--concurrent N]          Sync curated files/skills from manifest",
          "  batch [--concurrent N] [--json] <prompts-file>   Run prompts in parallel",
          "  run-task <task-id> <prompt>                      Dispatch task + auto-fetch result",
          "  ping                                             Identity round-trip check",
          "",
          "Auth: requires FAUNA_ZO_TOKEN in env (source /root/.zo_secrets)",
          "      (ZO_B_API_KEY accepted as legacy fallback)",
          "",
          "Known personas: " + Object.keys(PERSONA_REGISTRY).join(", "),
        ].join("\n"),
      );
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Run with --help for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
