/**
 * ZouroBench Results Explorer — production server tests (ZBRE-012 / ZOU-840).
 *
 * Exercises the combined production surface: same-origin live API, static SPA
 * serving with history fallback for all six routes, path-traversal containment,
 * and the read-only (no-write) guarantee across both surfaces.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createArtifactStore } from "./artifact-store";
import {
  handleProductionRequest,
  resolveStaticFile,
  isLoopbackHost,
  SPA_ROUTES,
  DEFAULT_SITE_DIST,
} from "./prod-server";
import { DEFAULT_DATA_ROOT } from "./server";

let dist: string;
let dataRoot: string;
let store: ReturnType<typeof createArtifactStore>;

beforeAll(() => {
  dist = mkdtempSync(resolve(tmpdir(), "zbre-dist-"));
  writeFileSync(resolve(dist, "index.html"), "<!doctype html><title>Explorer</title><div id=root></div>");
  mkdirSync(resolve(dist, "assets"));
  writeFileSync(resolve(dist, "assets", "index-abc123.js"), "console.info('shell')");
  writeFileSync(resolve(dist, "assets", "index-abc123.css"), ":root{}");
  // Secret outside the dist root used to prove traversal containment.
  writeFileSync(resolve(dist, "..", "zbre-secret.txt"), "TOP SECRET");

  dataRoot = DEFAULT_DATA_ROOT;
  store = createArtifactStore({ dataRoot });
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(resolve(dist, "..", "zbre-secret.txt"), { force: true });
});

function get(path: string, method = "GET"): Response {
  return handleProductionRequest(store, dist, new Request(`http://127.0.0.1${path}`, { method }));
}

describe("live API across the process boundary", () => {
  test("health reports the live artifact roots", async () => {
    const res = get("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; roots: Array<{ kind: string; path: string; exists: boolean }> };
    expect(body.status).toBe("ok");
    const runs = body.roots.find((r) => r.kind === "runs");
    expect(runs?.exists).toBe(true);
    expect(runs?.path).toContain(resolve(dataRoot, "runs"));
  });

  test("run discovery returns the live runs, not fixtures", async () => {
    const res = get("/api/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pagination: { total_items: number }; items: Array<{ id: string }> };
    expect(body.pagination.total_items).toBeGreaterThan(0);
    expect(body.items.every((r) => r.id.startsWith("ZouroBench-"))).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("static SPA serving", () => {
  test("root serves the shell", () => {
    const res = get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("all six routes are directly addressable via history fallback", async () => {
    for (const route of SPA_ROUTES) {
      const res = get(`/${route}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("id=root");
    }
  });

  test("deep route with query still resolves the shell", () => {
    expect(get("/runs?run=abc&state=loading").status).toBe(200);
  });

  test("hashed assets are served immutably", () => {
    const res = get("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  test("a missing hashed asset is a 404, never a shell fallback", () => {
    expect(get("/assets/does-not-exist.js").status).toBe(404);
  });
});

describe("path safety", () => {
  test("dot-dot traversal cannot escape the dist root", () => {
    expect(resolveStaticFile(dist, "/../zbre-secret.txt")).toBeNull();
    expect(resolveStaticFile(dist, "/../../etc/passwd")).toBeNull();
  });

  test("encoded traversal never serves content outside the root", async () => {
    // The URL parser collapses literal `..`; `%2F` never becomes a separator.
    // A traversal-shaped path resolves to no file and yields the shell, never
    // the out-of-root secret.
    for (const path of ["/..%2Fzbre-secret.txt", "/%2e%2e/zbre-secret.txt", "/../zbre-secret.txt"]) {
      const body = await get(path).text();
      expect(body).not.toContain("TOP SECRET");
    }
  });

  test("a symlink pointing outside the root is refused", () => {
    const link = resolve(dist, "escape.txt");
    symlinkSync(resolve(dist, "..", "zbre-secret.txt"), link);
    expect(resolveStaticFile(dist, "/escape.txt")).toBeNull();
    rmSync(link, { force: true });
  });
});

describe("read-only (no-write) guarantee", () => {
  test("mutating methods on the API return 405", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = get("/api/runs", method);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toContain("GET");
    }
  });

  test("mutating methods on static routes return 405", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = get("/runs", method);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toContain("GET");
    }
  });

  test("HEAD is allowed and carries no body", async () => {
    const res = get("/", "HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("configuration defaults", () => {
  test("the default site dist points at the built Site", () => {
    expect(DEFAULT_SITE_DIST.endsWith("/Sites/zourobench-results-explorer/dist")).toBe(true);
  });

  test("only loopback hosts are recognized as private", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "::"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
