import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditProject } from "./audit-project";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("auditProject", () => {
  test("detects a minimal instrumented Three.js project", () => {
    const root = mkdtempSync(join(tmpdir(), "threejs-audit-"));
    created.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      scripts: { build: "tsc --noEmit && vite build", test: "vitest run", "test:e2e": "playwright test" },
      dependencies: { three: "latest" },
    }));
    writeFileSync(join(root, "main.ts"), "new WebGLRenderer(); renderer.info.render.calls; window.__GAME_TEST__ = {}; addEventListener('resize', f); addEventListener('pointerdown', f); new GLTFLoader();");

    const report = auditProject(root);
    expect(report.findings.find((finding) => finding.id === "threejs")?.status).toBe("pass");
    expect(report.hooks).toEqual(["__GAME_TEST__"]);
  });

  test("does not treat test-only hooks as runtime wiring", () => {
    const root = mkdtempSync(join(tmpdir(), "threejs-audit-"));
    created.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { three: "latest" } }));
    writeFileSync(join(root, "main.ts"), "new WebGLRenderer();");
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests", "game.spec.ts"), "window.__TEST_ONLY__ = {};");

    const report = auditProject(root);
    expect(report.hooks).toEqual([]);
    expect(report.findings.find((finding) => finding.id === "runtime-hooks")?.status).toBe("warn");
  });
});
