/**
 * Tool runners — wrap external CLIs (gitleaks, semgrep, lighthouse, etc.)
 * and provide graceful fallback when a tool isn't installed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

export interface ToolStatus {
  name: string;
  available: boolean;
  path?: string;
  version?: string;
}

const TOOL_CACHE: Map<string, ToolStatus> = new Map();

export function whichTool(name: string): ToolStatus {
  if (TOOL_CACHE.has(name)) return TOOL_CACHE.get(name)!;
  const result = spawnSync("which", [name], { encoding: "utf8" });
  let status: ToolStatus = { name, available: false };
  if (result.status === 0 && result.stdout.trim()) {
    const path = result.stdout.trim();
    let version: string | undefined;
    try {
      const v = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 5000 });
      if (v.stdout) version = v.stdout.trim().split("\n")[0];
    } catch {}
    status = { name, available: true, path, version };
  }
  TOOL_CACHE.set(name, status);
  return status;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): { stdout: string; stderr: string; status: number | null; timedOut: boolean } {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    input: opts.input,
    maxBuffer: 100 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    timedOut: result.signal === "SIGTERM",
  };
}

/**
 * Walk a directory, returning files that match `pred(path)`.
 * Skips node_modules, .git, dist, build, .next, target, vendor by default.
 */
export function walkRepo(
  root: string,
  pred: (relPath: string, fullPath: string) => boolean,
  opts: { maxFiles?: number; maxBytes?: number } = {},
): string[] {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".turbo",
    ".cache",
    "coverage",
    ".output",
  ]);
  const found: string[] = [];

  function walk(dir: string, rel: string) {
    if (found.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, relPath);
      } else if (st.isFile() && st.size <= maxBytes) {
        if (pred(relPath, full)) {
          found.push(full);
          if (found.length >= maxFiles) return;
        }
      }
    }
  }
  walk(root, "");
  return found;
}

/**
 * Grep over a list of files. Returns matches with line numbers.
 * Uses naive in-process regex — for fancy needs, shell out to ripgrep.
 */
export function grepFiles(
  files: string[],
  pattern: RegExp,
  opts: { maxMatches?: number; contextChars?: number } = {},
): Array<{ file: string; line: number; snippet: string; match: string }> {
  const maxMatches = opts.maxMatches ?? 200;
  const contextChars = opts.contextChars ?? 120;
  const results: Array<{ file: string; line: number; snippet: string; match: string }> = [];

  for (const file of files) {
    if (results.length >= maxMatches) break;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(pattern);
      if (m) {
        const start = Math.max(0, (m.index ?? 0) - contextChars / 2);
        const end = Math.min(line.length, (m.index ?? 0) + m[0].length + contextChars / 2);
        results.push({
          file,
          line: i + 1,
          snippet: line.slice(start, end).trim(),
          match: m[0],
        });
        if (results.length >= maxMatches) break;
      }
    }
  }
  return results;
}

/** Detect tech stack from common manifest files. */
export function detectStack(repoPath: string): { stack: string[]; deployment: string | null; manifests: string[] } {
  const stack: string[] = [];
  const manifests: string[] = [];
  let deployment: string | null = null;

  const checks: Array<[string, string]> = [
    ["package.json", "node"],
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Gemfile", "ruby"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["composer.json", "php"],
    ["pom.xml", "java-maven"],
    ["build.gradle", "java-gradle"],
    ["Dockerfile", "docker"],
    ["docker-compose.yml", "docker-compose"],
    ["docker-compose.yaml", "docker-compose"],
  ];
  for (const [f, label] of checks) {
    if (existsSync(join(repoPath, f))) {
      stack.push(label);
      manifests.push(f);
    }
  }

  const deployChecks: Array<[string, string]> = [
    ["vercel.json", "vercel"],
    ["netlify.toml", "netlify"],
    ["fly.toml", "fly.io"],
    ["render.yaml", "render"],
    ["railway.json", "railway"],
    [".do/app.yaml", "digitalocean"],
    ["wrangler.toml", "cloudflare-workers"],
    ["app.yaml", "google-app-engine"],
    ["serverless.yml", "serverless"],
    ["sam.yaml", "aws-sam"],
  ];
  for (const [f, label] of deployChecks) {
    if (existsSync(join(repoPath, f))) {
      deployment = label;
      manifests.push(f);
      break;
    }
  }

  // Frontend framework sniff
  if (existsSync(join(repoPath, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const fw of ["next", "remix", "@remix-run/node", "nuxt", "astro", "@sveltejs/kit", "vite", "react", "vue", "svelte", "solid-js", "hono", "express", "fastify", "@nestjs/core"]) {
        if (deps[fw]) stack.push(fw);
      }
    } catch {}
  }

  return { stack: [...new Set(stack)], deployment, manifests };
}

/** Read a file safely, returning null on any error. */
export function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Common source file extensions */
export const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".php", ".java", ".kt", ".scala",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".swift", ".dart", ".vue", ".svelte", ".astro",
]);

export const CONFIG_EXTS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".env", ".ini", ".xml",
]);

export function isSource(path: string): boolean {
  return SOURCE_EXTS.has(extname(path).toLowerCase());
}

export function isConfig(path: string): boolean {
  return CONFIG_EXTS.has(extname(path).toLowerCase()) || basename(path).startsWith(".env");
}
