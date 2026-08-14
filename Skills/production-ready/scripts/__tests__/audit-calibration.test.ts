import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiSafetyCheck, hasProjectRateLimit, measureValidationCoverage } from "../checks/04-api-safety.ts";
import { legalCheck } from "../checks/01-legal.ts";
import { analyseLighthouseReport } from "../checks/10-performance.ts";
import { databaseCheck, findSqlConcatenation } from "../checks/13-database.ts";
import { isDevRequestLeak } from "../checks/15-browser-test.ts";

const tempDirs: string[] = [];

function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "production-ready-calibration-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("database SQL concatenation calibration", () => {
  test("ignores JSX labels and parameterized ORM tagged templates", () => {
    const file = fixture(
      "safe.tsx",
      [
        "const label = `Delete ${entry.date} check-in`;",
        "const updateRecipe = (recipe: Recipe) => save(recipe);",
        "const rows = await db.select().from(users).where(eq(users.id, id));",
        "const deleted = await db.execute(sql`DELETE FROM checkins WHERE id = ${id}`);",
      ].join("\n"),
    );
    const testFile = fixture(
      "startup.test.ts",
      "const count = db.query(`SELECT count(*) FROM ${JSON.stringify(table)}`).get();",
    );

    expect(findSqlConcatenation([file, testFile])).toEqual([]);
  });

  test("retains critical hard blockers for interpolated and concatenated SQL sinks", async () => {
    const file = fixture(
      "unsafe.ts",
      [
        "await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);",
        "await connection.execute('DELETE FROM users WHERE id = ' + req.body.id);",
      ].join("\n"),
    );

    const hits = findSqlConcatenation([file]);
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.line)).toEqual([1, 2]);

    const repo = join(file, "..");
    const result = await databaseCheck.run({ repoPath: repo, outDir: repo, format: "json" });
    const blockers = result.findings.filter((finding) => finding.id.startsWith("db.sql-concat"));
    expect(blockers).toHaveLength(2);
    expect(blockers.every((finding) => finding.severity === "critical" && finding.hardBlocker)).toBe(true);
  });
});

describe("API safety calibration", () => {
  test("counts manual guards per request boundary without blessing a later unsafe handler", () => {
    const file = fixture(
      "routes.ts",
      [
        "app.post('/checked', async (c) => {",
        "  const body = await c.req.json();",
        "  if (typeof body.date !== 'string') return c.json({ error: 'date' }, 400);",
        "  const date = new Date(body.date);",
        "  if (Number.isNaN(date.getTime())) return c.json({ error: 'date' }, 400);",
        "  if (!Object.values(Status).includes(body.status)) return c.json({ error: 'status' }, 400);",
        "  return c.json({ ok: true });",
        "});",
        "app.post('/unsafe', async (c) => {",
        "  const body = await c.req.json();",
        "  return c.json(await save(body));",
        "});",
      ].join("\n"),
    );

    const coverage = measureValidationCoverage([file]);
    expect(coverage.total).toBe(2);
    expect(coverage.validated).toBe(1);
    expect(coverage.unvalidated.map((hit) => hit.line)).toEqual([10]);
  });

  test("recognizes a reachable project-local rate limiter", () => {
    const middleware = fixture(
      "rate-limit.ts",
      [
        "export function enforceRateLimit(key: string) {",
        "  if (increment(key) > maxRequests) return new Response('Too Many Requests', { status: 429 });",
        "}",
      ].join("\n"),
    );
    const route = fixture(
      "route.ts",
      [
        "import { enforceRateLimit } from './rate-limit';",
        "export async function POST(req: Request) {",
        "  enforceRateLimit(req.headers.get('x-forwarded-for') ?? 'unknown');",
        "  return Response.json(await req.json());",
        "}",
      ].join("\n"),
    );

    expect(hasProjectRateLimit([middleware, route])).toBe(true);
  });

  test("does not confuse upstream provider throttling with inbound middleware", () => {
    const limiter = fixture(
      "rate-limit.ts",
      [
        "export class RateLimitedError extends Error {}",
        "export class SlidingWindowLimiter {",
        "  hold() { return new Response('Too Many Requests', { status: 429 }); }",
        "}",
      ].join("\n"),
    );
    const provider = fixture(
      "provider.ts",
      [
        "import { RateLimitedError, SlidingWindowLimiter } from './rate-limit';",
        "export async function fetchProvider(req: Request) {",
        "  const limiter = new SlidingWindowLimiter();",
        "  return fetch(req.url).catch(() => { throw new RateLimitedError(); });",
        "}",
      ].join("\n"),
    );

    expect(hasProjectRateLimit([limiter, provider])).toBe(false);
  });

  test("reports deliberately unvalidated boundaries while accepting local rate limiting", async () => {
    const route = fixture(
      "routes.ts",
      [
        "export function enforceRateLimit(key: string) {",
        "  if (increment(key) > maxRequests) return new Response('Too Many Requests', { status: 429 });",
        "}",
        "app.post('/checked', async (c) => {",
        "  const body = await c.req.json();",
        "  if (typeof body.name !== 'string') return c.json({}, 400);",
        "  enforceRateLimit('checked');",
        "  return c.json(body);",
        "});",
        ...["one", "two", "three"].flatMap((name) => [
          `app.post('/${name}', async (c) => {`,
          "  const body = await c.req.json();",
          "  return c.json(await save(body));",
          "});",
        ]),
      ].join("\n"),
    );
    const repo = join(route, "..");
    const result = await apiSafetyCheck.run({ repoPath: repo, outDir: repo, format: "json" });

    expect(result.findings.some((finding) => finding.id === "api.low-validation-coverage")).toBe(true);
    expect(result.findings.some((finding) => finding.id === "api.no-rate-limit")).toBe(false);
  });
});

describe("Lighthouse redirect calibration", () => {
  test("turns a cross-origin auth redirect into a coverage gap and suppresses its metrics", () => {
    const analysis = analyseLighthouseReport(
      {
        requestedUrl: "https://ori.example.test/",
        finalDisplayedUrl: "https://www.example.test/signup?next=ori",
        categories: { performance: { score: 0.42 } },
        audits: {
          "largest-contentful-paint": { numericValue: 6515 },
          "total-blocking-time": { numericValue: 900 },
        },
      },
      "https://ori.example.test/",
    );

    expect(analysis.findings).toEqual([]);
    expect(analysis.coverage?.status).toBe("partial");
    expect(analysis.coverage?.reason).toContain("cross-origin redirect");
  });

  test("retains performance findings after a same-origin redirect", () => {
    const analysis = analyseLighthouseReport(
      {
        finalDisplayedUrl: "https://ori.example.test/login",
        categories: { performance: { score: 0.42 } },
        audits: { "largest-contentful-paint": { numericValue: 6515 } },
      },
      "https://ori.example.test/",
    );

    expect(analysis.coverage).toBeUndefined();
    expect(analysis.findings.map((finding) => finding.id)).toContain("perf.lcp-slow");
  });
});

describe("data-rights and browser-origin calibration", () => {
  test("recognizes a mounted sub-app export route", async () => {
    const route = fixture(
      "account.ts",
      'accountApi.get("/export", (c) => c.json(exportDatasetJson()));',
    );
    const repo = join(route, "..");
    const result = await legalCheck.run({
      repoPath: repo,
      outDir: repo,
      format: "json",
      surfaces: { userData: true },
    });

    expect(result.findings.some((finding) => finding.id === "legal.no-data-export")).toBe(false);
  });

  test("does not report the audited localhost origin as a production leak", () => {
    expect(isDevRequestLeak("http://127.0.0.1:5318/api/health", "http://127.0.0.1:5318")).toBe(false);
    expect(isDevRequestLeak("http://localhost:3000/api/health", "https://ori.example.test")).toBe(true);
  });
});
