import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateCostUsd,
  reapExpiredWorkers,
  runEphemeralWorker,
  validateManifest,
  type CommandRunner,
  type SpawnResult,
} from "../src/ephemeral-worker";

function result(stdout = "", exitCode = 0): SpawnResult {
  return { exitCode, stdout, stderr: "", timedOut: false, elapsedMs: 10 };
}

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<SpawnResult> {
    this.calls.push({ command, args });
    if (command === "ssh-keygen") {
      const keyPath = args[args.indexOf("-f") + 1];
      writeFileSync(keyPath, "private");
      writeFileSync(`${keyPath}.pub`, "ssh-ed25519 fake");
      return result();
    }
    if (command === "hcloud" && args[0] === "server-type") {
      return result(JSON.stringify({
        prices: [{ location: "hel1", price_hourly: { gross: "0.2612" } }],
      }));
    }
    if (command === "hcloud" && args[0] === "ssh-key" && args[1] === "create") {
      return result(JSON.stringify({ ssh_key: { id: 9, name: args[args.indexOf("--name") + 1] } }));
    }
    if (command === "hcloud" && args[0] === "server" && args[1] === "create") {
      return result(JSON.stringify({
        server: {
          id: 42,
          name: args[args.indexOf("--name") + 1],
          public_net: { ipv4: { ip: "203.0.113.10" } },
          labels: {},
        },
      }));
    }
    return result(command === "ssh" && args.at(-1)?.includes("bun test") ? "tests passed\n" : "");
  }
}

describe("external compute manifest", () => {
  test("applies bounded CCX33 defaults", () => {
    const manifest = validateManifest({ version: 1, commands: ["bun test"] });
    expect(manifest.server_type).toBe("ccx33");
    expect(manifest.location).toBe("hel1");
    expect(manifest.ttl_minutes).toBe(60);
    expect(manifest.max_cost_usd).toBe(0.5);
  });

  test("rejects traversal and excessive TTL", () => {
    expect(() => validateManifest({ version: 1, commands: ["x"], artifacts: ["../secret"] })).toThrow();
    expect(() => validateManifest({ version: 1, commands: ["x"], artifacts: ["dist with spaces"] })).toThrow();
    expect(() => validateManifest({ version: 1, commands: ["x"], ttl_minutes: 121 })).toThrow();
  });

  test("estimates elapsed cost", () => {
    expect(estimateCostUsd(0.2612, 30 * 60_000)).toBe(0.1306);
  });
});

describe("ephemeral worker lifecycle", () => {
  test("creates, executes, records evidence, and deletes resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "zbr-test-"));
    writeFileSync(join(root, "package.json"), "{}");
    const evidenceDir = join(root, "evidence");
    const runner = new FakeRunner();
    const started = new Date();
    const times = [
      started,
      new Date(started.getTime() + 5 * 60_000),
    ];
    const evidence = await runEphemeralWorker({
      workdir: root,
      evidenceDir,
      manifest: { version: 1, commands: ["bun test"] },
      env: { HCLOUD_TOKEN: "test-token" },
      commandRunner: runner,
      now: () => times.shift() ?? new Date(started.getTime() + 5 * 60_000),
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.server.type).toBe("ccx33");
    expect(evidence.teardown.server_deleted).toBe(true);
    expect(evidence.teardown.ssh_key_deleted).toBe(true);
    expect(existsSync(join(evidenceDir, "evidence.json"))).toBe(true);
    expect(runner.calls.some((call) => call.command === "hcloud" && call.args.slice(0, 2).join(" ") === "server delete")).toBe(true);
  });

  test("transfers secret environment without recording its value", async () => {
    const root = mkdtempSync(join(tmpdir(), "zbr-test-env-"));
    writeFileSync(join(root, "package.json"), "{}");
    const evidenceDir = join(root, "evidence");
    const runner = new FakeRunner();
    const evidence = await runEphemeralWorker({
      workdir: root,
      evidenceDir,
      manifest: { version: 1, commands: ["bun test"] },
      env: { HCLOUD_TOKEN: "test-token" },
      remoteEnv: { OPENAI_API_KEY: "remote-secret-value" },
      commandRunner: runner,
    });

    const persisted = await Bun.file(join(evidenceDir, "evidence.json")).text();
    expect(evidence.remote_environment?.keys).toEqual(["OPENAI_API_KEY"]);
    expect(persisted).not.toContain("remote-secret-value");
    expect(runner.calls.some((call) => call.command === "scp" && call.args.at(-1)?.endsWith("/tmp/zouroboros-env.sh"))).toBe(true);
    const sourceTar = runner.calls.find((call) => call.command === "tar" && call.args.includes("-czf"));
    expect(sourceTar?.args.includes(".git")).toBe(true);
  });

  test("preserves a command failure and skips artifact collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "zbr-test-fail-"));
    writeFileSync(join(root, "package.json"), "{}");
    const runner = new FakeRunner();
    const baseRun = runner.run.bind(runner);
    runner.run = async (command, args) => {
      if (command === "ssh" && args.at(-1) === "/tmp/zouroboros-command.sh") {
        runner.calls.push({ command, args });
        return { ...result("", 127), stderr: "bun: command not found" };
      }
      return baseRun(command, args);
    };
    const evidence = await runEphemeralWorker({
      workdir: root,
      evidenceDir: join(root, "evidence"),
      manifest: { version: 1, commands: ["bun test"], artifacts: ["dist"] },
      env: { HCLOUD_TOKEN: "test-token" },
      commandRunner: runner,
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.error).toBe("command failed (127): bun test");
    expect(runner.calls.some((call) => call.command === "ssh" && call.args.includes("/tmp/zouroboros-artifacts.tgz"))).toBe(false);
    expect(evidence.teardown.server_deleted).toBe(true);
  });

  test("reaper deletes only expired labeled workers", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] === "server" && args[1] === "list") {
          return result(JSON.stringify([
            { id: 1, name: "expired", labels: { expires_unix: "100" } },
            { id: 2, name: "active", labels: { expires_unix: "300" } },
            { id: 3, name: "unlabeled", labels: {} },
          ]));
        }
        if (args[0] === "ssh-key" && args[1] === "list") {
          return result(JSON.stringify([
            { id: 4, name: "expired-key", labels: { expires_unix: "100" } },
            { id: 5, name: "active-key", labels: { expires_unix: "300" } },
          ]));
        }
        return result();
      },
    };
    const reaped = await reapExpiredWorkers({
      env: { HCLOUD_TOKEN: "test-token" },
      nowUnix: 200,
      commandRunner: runner,
    });
    expect(reaped.deleted.map((entry) => entry.id)).toEqual([1]);
    expect(reaped.retained.map((entry) => entry.id)).toEqual([2, 3]);
    expect(reaped.ssh_keys_deleted.map((entry) => entry.id)).toEqual([4]);
    expect(reaped.ssh_keys_retained.map((entry) => entry.id)).toEqual([5]);
    expect(calls.some((call) => call === "hcloud server delete 1")).toBe(true);
    expect(calls.some((call) => call === "hcloud server delete 2")).toBe(false);
    expect(calls.some((call) => call === "hcloud ssh-key delete 4")).toBe(true);
  });
});
