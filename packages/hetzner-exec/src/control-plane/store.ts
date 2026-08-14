import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ShadowEvent, ShadowJob } from "./types";

const LOCK_STALE_MS = 5 * 60_000;

export class ControlPlaneStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.jobsDir(), { recursive: true });
  }

  withLock<T>(fn: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, ".lock");
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch {
      throw new Error(`control-plane lock is held: ${path}`);
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(path);
    }
  }

  readJob(jobId: string): ShadowJob | null {
    const path = this.jobPath(jobId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ShadowJob;
  }

  listJobs(): ShadowJob[] {
    if (!existsSync(this.jobsDir())) return [];
    return readdirSync(this.jobsDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(this.jobsDir(), name), "utf8")) as ShadowJob)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  writeJob(job: ShadowJob): void {
    writeJsonAtomic(this.jobPath(job.job_id), job);
  }

  readIdempotency(): Record<string, string> {
    const path = join(this.root, "idempotency.json");
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  }

  writeIdempotency(index: Record<string, string>): void {
    writeJsonAtomic(join(this.root, "idempotency.json"), index);
  }

  appendEvent(event: ShadowEvent): void {
    appendFileSync(join(this.root, "events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  readEvents(): ShadowEvent[] {
    const path = join(this.root, "events.jsonl");
    if (!existsSync(path)) return [];
    const events: ShadowEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ShadowEvent);
      } catch {
        continue;
      }
    }
    return events;
  }

  private jobsDir(): string {
    return join(this.root, "jobs");
  }

  private jobPath(jobId: string): string {
    if (!/^job-[a-zA-Z0-9-]+$/.test(jobId)) throw new Error("invalid job id");
    return join(this.jobsDir(), `${jobId}.json`);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
