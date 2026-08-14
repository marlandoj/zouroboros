// Command execution. Two non-sandbox paths share one CommandRunner:
//   - direct:  `sh -c <command>` on the host
//   - docker:  `docker run --rm [-e K=V...] <image> sh -c <command>`
//
// The CommandRunner abstraction lets tests inject a fake that returns canned
// RunResults without spawning real processes (and without needing docker).

import { spawn, type ChildProcess } from "node:child_process";
import type { RunResult } from "./types";

export interface RunnerArgs {
  /** Full argv, e.g. ["sh","-c","echo hello"] or ["docker","run","--rm","debian:12","sh","-c","..."]. */
  argv: string[];
  /** Extra env merged onto process.env for the spawned process (direct mode). */
  env?: Record<string, string>;
  /** Hard kill after this many ms. 0 = no timeout. */
  timeoutMs: number;
}

export interface CommandRunner {
  run(args: RunnerArgs): Promise<RunResult>;
}

/** Conventional exit code when a command is killed for timeout. */
export const EXIT_TIMEOUT = 124;
/** Conventional exit code when the spawn itself failed (binary missing, etc.). */
export const EXIT_SPAWN_ERROR = 127;

/** Build the argv to run a command on the host shell. Pure. */
export function buildDirectArgv(command: string): string[] {
  return ["sh", "-c", command];
}

/**
 * Build the argv for `docker run --rm <image> sh -c <command>`.
 *
 * The command is passed as a single argv element (NOT interpolated into a
 * shell line), so the image's `sh -c` receives it verbatim — no shell
 * injection on the host side. Env values are passed via `-e K=V` so they
 * never touch a shell either.
 */
export function buildDockerArgv(
  image: string,
  command: string,
  env: Record<string, string> | undefined,
  extraFlags: readonly string[] = [],
): string[] {
  const argv = ["docker", "run", "--rm", ...extraFlags];
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      argv.push("-e", `${k}=${v}`);
    }
  }
  argv.push(image, "sh", "-c", command);
  return argv;
}

/** Real runner backed by `node:child_process.spawn`. Captures stdout/stderr, enforces timeout via SIGKILL. */
export class LocalRunner implements CommandRunner {
  run(args: RunnerArgs): Promise<RunResult> {
    return new Promise((resolve) => {
      const start = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const child: ChildProcess = spawn(args.argv[0], args.argv.slice(1), {
        env: args.env ? { ...process.env, ...args.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve({
          exit_code: timedOut ? EXIT_TIMEOUT : code,
          stdout,
          stderr,
          elapsed_ms: Date.now() - start,
          timed_out: timedOut,
        });
      };

      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (e: Error) => {
        stderr += `\n[spawn error] ${e.message}`;
        finish(EXIT_SPAWN_ERROR);
      });
      child.on("close", (code: number | null) => {
        finish(code ?? 0);
      });

      if (args.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* process already gone — ignore */
          }
        }, args.timeoutMs);
      }
    });
  }
}
