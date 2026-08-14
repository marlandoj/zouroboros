#!/usr/bin/env bun
/**
 * Unit self-test for the hetzner-exec MCP server package.
 *
 * Fully hermetic: docker and hcloud are exercised via injected fakes (no
 * docker daemon, no live Hetzner API, no network). The direct-execution path
 * is exercised for real via the host `sh`.
 *
 * Sections:
 *   1. auth (constant-time compare, length mismatch, empty, bearer extraction)
 *   2. validate (good, missing command, bad types, env key rules)
 *   3. config (defaults, bad provider, bad port)
 *   4. executor (argv builders; LocalRunner real `echo` + timeout)
 *   5. sandbox: InMemoryCallbackRegistry (deliver / timeout / double-deliver)
 *   6. sandbox: DockerSandboxProvider via fake runner (--network=none, destroy noop)
 *   7. sandbox: HcloudSandboxProvider via fake client + registry (create → deliver → destroy)
 *   8. cloud-init generator (valid YAML + expected elements)
 *
 * Exit 0 = all green.
 */

import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { tokenMatches, extractBearer } from "../src/auth";
import { validateRequest } from "../src/validate";
import { loadConfig, ConfigError } from "../src/config";
import { buildDirectArgv, buildDockerArgv, LocalRunner, EXIT_TIMEOUT, type CommandRunner, type RunnerArgs } from "../src/executor";
import {
  InMemoryCallbackRegistry,
  DockerSandboxProvider,
  HcloudSandboxProvider,
  defaultCloudInit,
  createSandboxProvider,
} from "../src/sandbox";
import type { HcloudClient, HcloudServer, CreateServerInput } from "../src/hcloud";
import type { RunResult } from "../src/types";

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

section("1. auth");
checkT("tokenMatches exact", tokenMatches("abc", "abc"));
checkT("tokenMatches mismatch", !tokenMatches("abc", "abd"));
checkT("tokenMatches length-mismatch short", !tokenMatches("abc", "abcd"));
checkT("tokenMatches empty presented", !tokenMatches("", "abc"));
checkT("tokenMatches empty expected", !tokenMatches("abc", ""));
checkT("extractBearer parses", extractBearer("Bearer abc") === "abc");
checkT("extractBearer trims", extractBearer("Bearer   abc  ") === "abc");
checkT("extractBearer case-insensitive scheme", extractBearer("bearer abc") === "abc");
checkT("extractBearer non-bearer null", extractBearer("Basic abc") === null);
checkT("extractBearer undefined null", extractBearer(undefined) === null);
// timingSafeEqual is importable (no throw on equal-length)
checkT("timingSafeEqual equal buffers", (() => { const a = Buffer.from("x"); const b = Buffer.from("x"); return timingSafeEqual(a, b); })());

section("2. validate");
checkT("validate good request", validateRequest({ command: "echo hi" }).command === "echo hi");
checkT("validate carries optional fields", validateRequest({ command: "c", docker_image: "alpine", env: { A: "1" }, timeout: 500, sandbox: true }).sandbox === true);
let threw = false; try { validateRequest({}); } catch { threw = true; }
checkT("validate missing command throws", threw && validateRequest.name.length > 0);
threw = false; try { validateRequest({ command: "" }); } catch { threw = true; }
checkT("validate empty command throws", threw);
threw = false; try { validateRequest({ command: "c", env: { "1bad": "x" } }); } catch (e) { threw = (e as Error).message.includes("invalid env key"); }
checkT("validate bad env key throws", threw);
threw = false; try { validateRequest({ command: "c", timeout: -1 }); } catch { threw = true; }
checkT("validate negative timeout throws", threw);
threw = false; try { validateRequest({ command: "c", sandbox: "yes" }); } catch { threw = true; }
checkT("validate non-boolean sandbox throws", threw);
threw = false; try { validateRequest("notanobject" as unknown); } catch { threw = true; }
checkT("validate non-object throws", threw);

section("3. config");
const def = loadConfig({ HETZNER_EXEC_TOKEN: "t" });
checkT("config default port 6666", def.port === 6666);
checkT("config default provider docker", def.sandboxProvider === "docker");
checkT("config default image debian:12-slim", def.defaultDockerImage === "debian:12-slim");
checkT("config token loaded", def.authToken === "t");
const cfg2 = loadConfig({ HETZNER_EXEC_TOKEN: "t", HETZNER_EXEC_PORT: "7000", HETZNER_EXEC_SANDBOX_PROVIDER: "hcloud", HETZNER_API_TOKEN: "hc" });
checkT("config override port", cfg2.port === 7000);
checkT("config override provider hcloud", cfg2.sandboxProvider === "hcloud");
checkT("config hcloud token", cfg2.hcloudToken === "hc");
let cfgThrew = false; try { loadConfig({ HETZNER_EXEC_TOKEN: "t", HETZNER_EXEC_SANDBOX_PROVIDER: "bogus" }); } catch (e) { cfgThrew = e instanceof ConfigError; }
checkT("config bad provider throws ConfigError", cfgThrew);
cfgThrew = false; try { loadConfig({ HETZNER_EXEC_TOKEN: "t", HETZNER_EXEC_PORT: "99999" }); } catch { cfgThrew = true; }
checkT("config bad port throws", cfgThrew);

section("4. executor");
checkT("buildDirectArgv shape", JSON.stringify(buildDirectArgv("echo hi")) === JSON.stringify(["sh", "-c", "echo hi"]));
const dargv = buildDockerArgv("alpine", "echo hi", { A: "1", B: "2" }, ["--network=none"]);
checkT("buildDockerArgv uses --rm", dargv.includes("--rm"));
checkT("buildDockerArgv includes network flag", dargv.includes("--network=none"));
checkT("buildDockerArgv ends with sh -c cmd", dargv[dargv.length - 3] === "sh" && dargv[dargv.length - 2] === "-c" && dargv[dargv.length - 1] === "echo hi");
checkT("buildDockerArgv passes env as -e pairs", dargv.includes("-e") && dargv.includes("A=1") && dargv.includes("B=2"));
checkT("buildDockerArgv no env ok", buildDockerArgv("alpine", "c", undefined).includes("alpine"));

const runner = new LocalRunner();
const rr = await runner.run({ argv: buildDirectArgv("echo hello"), env: undefined, timeoutMs: 5000 });
checkT("LocalRunner echo hello exit 0", rr.exit_code === 0, `exit=${rr.exit_code} err=${rr.stderr}`);
checkT("LocalRunner echo hello stdout", rr.stdout.trim() === "hello", `stdout=${JSON.stringify(rr.stdout)}`);
checkT("LocalRunner echo hello elapsed_ms >= 0", rr.elapsed_ms >= 0);
const rrfail = await runner.run({ argv: ["sh", "-c", "exit 7"], env: undefined, timeoutMs: 5000 });
checkT("LocalRunner exit code propagated", rrfail.exit_code === 7, `exit=${rrfail.exit_code}`);
const rrto = await runner.run({ argv: ["sh", "-c", "sleep 2"], env: undefined, timeoutMs: 200 });
checkT("LocalRunner timeout kills (exit 124)", rrto.exit_code === 124 && rrto.timed_out, `exit=${rrto.exit_code} timed_out=${rrto.timed_out}`);

section("5. callback registry");
const reg = new InMemoryCallbackRegistry();
const { promise } = reg.register("r1", 60_000);
checkT("registry has pending", reg.has("r1"));
const delivered = reg.deliver("r1", { exit_code: 0, stdout: "o", stderr: "", elapsed_ms: 1, timed_out: false });
checkT("registry deliver returns true", delivered);
const got = await promise;
checkT("registry deliver resolves promise", got.exit_code === 0 && got.stdout === "o");
checkT("registry no longer pending after deliver", !reg.has("r1"));
checkT("registry deliver unknown returns false", reg.deliver("nope", { exit_code: 0, stdout: "", stderr: "", elapsed_ms: 0, timed_out: false }) === false);
// timeout path
const reg2 = new InMemoryCallbackRegistry();
const t = reg2.register("to", 80);
const tres = await t.promise;
checkT("registry timeout resolves with 124", tres.exit_code === EXIT_TIMEOUT && tres.timed_out, `exit=${tres.exit_code} to=${tres.timed_out}`);
t.cleanup();

section("6. docker sandbox provider");
const dockerCalls: RunnerArgs[] = [];
const fakeRunner: CommandRunner = {
  run: async (args: RunnerArgs) => {
    dockerCalls.push(args);
    return { exit_code: 0, stdout: "sandboxed\n", stderr: "", elapsed_ms: 7, timed_out: false } as RunResult;
  },
};
const dockerProvider = new DockerSandboxProvider(fakeRunner, "debian:12-slim");
const dhandle = await dockerProvider.run({ command: "echo hi", sandbox: true }, 10_000);
checkT("docker sandbox sandboxId prefix", dhandle.sandboxId.startsWith("docker-"));
const dargv1 = dockerCalls[dockerCalls.length - 1].argv;
checkT("docker sandbox argv uses --network=none", dargv1.includes("--network=none"), JSON.stringify(dargv1));
checkT("docker sandbox argv uses --rm", dargv1.includes("--rm"));
checkT("docker sandbox argv uses default image", dargv1.includes("debian:12-slim"));
const dres = await dhandle.result;
checkT("docker sandbox returns fake stdout", dres.stdout === "sandboxed\n");
await dhandle.destroy(); // should be a noop (no throw)
checkT("docker sandbox destroy noop", true);
// sandbox with explicit image
await dockerProvider.run({ command: "c", sandbox: true, docker_image: "alpine:3" }, 10_000);
checkT("docker sandbox uses explicit image", dockerCalls[dockerCalls.length - 1].argv.includes("alpine:3"));

section("7. hcloud sandbox provider");
const created: CreateServerInput[] = [];
const deleted: number[] = [];
const fakeClient: HcloudClient = {
  createServer: async (input: CreateServerInput): Promise<HcloudServer> => {
    created.push(input);
    return { id: 4242, name: input.name, status: "running", publicIp: "203.0.113.7" };
  },
  getServer: async (id: number): Promise<HcloudServer> => ({ id, name: "x", status: "running", publicIp: "203.0.113.7" }),
  deleteServer: async (id: number): Promise<void> => { deleted.push(id); },
  powerOn: async (_id: number): Promise<void> => { /* noop */ },
};
const cb = new InMemoryCallbackRegistry();
const hprovider = new HcloudSandboxProvider({
  client: fakeClient,
  callbacks: cb,
  cloudInit: defaultCloudInit,
  publicBaseUrl: "https://box.example.com",
  authToken: "tok",
  serverType: "cx22",
  image: "debian-12",
  location: "fsn1",
  sshKeyName: "hetzner-annex-key",
});
const hhandle = await hprovider.run({ command: "echo hi", sandbox: true }, 60_000);
checkT("hcloud created one server", created.length === 1);
checkT("hcloud server name prefixed sbx-", created[0].name.startsWith("sbx-"));
checkT("hcloud user_data is cloud-config", typeof created[0].userData === "string" && created[0].userData.startsWith("#cloud-config"));
checkT("hcloud sandboxId = runId (callback path)", typeof hhandle.sandboxId === "string" && hhandle.sandboxId.startsWith("hcloud-"));
// simulate the VM posting its result back along the callback path
const deliveredH = cb.deliver(hhandle.sandboxId, { exit_code: 0, stdout: "hi\n", stderr: "", elapsed_ms: 12, timed_out: false });
checkT("hcloud callback delivered", deliveredH);
const hres = await hhandle.result;
checkT("hcloud result from callback", hres.exit_code === 0 && hres.stdout === "hi\n", JSON.stringify(hres));
await hhandle.destroy();
checkT("hcloud destroy deleted server 4242", deleted.includes(4242), JSON.stringify(deleted));
// hcloud provider without publicBaseUrl should be rejected at factory level
let hcThrew = false;
try {
  createSandboxProvider(
    { port: 6666, authToken: "t", sandboxProvider: "hcloud", defaultDockerImage: "x", defaultTimeoutMs: 1, maxTimeoutMs: 1, hcloudServerType: "cx22", hcloudImage: "debian-12", hcloudLocation: "fsn1", hcloudSshKeyName: "k" },
    fakeRunner,
    new InMemoryCallbackRegistry(),
  );
} catch {
  hcThrew = true;
}
checkT("hcloud factory throws without publicBaseUrl", hcThrew);

section("8. cloud-init generator");
const ci = defaultCloudInit({ runId: "hcloud-deadbeef", callbackUrl: "https://box.example.com/sandbox/callback/hcloud-deadbeef", authToken: "sekret", command: "echo hi; rm -rf /" });
// The command + agent script are carried base64 in write_files so no secret,
// URL, or command ever touches a shell in plaintext. Decode them to assert the
// agent behaviour, and assert the rendered cloud-init leaks none of it in clear.
const decoded = [...ci.matchAll(/content: "([A-Za-z0-9+/=]+)"/g)]
  .map((m) => Buffer.from(m[1], "base64").toString("utf8"))
  .join("\n");
checkT("cloud-init starts with #cloud-config", ci.startsWith("#cloud-config"));
checkT("cloud-init agent contains callback URL", decoded.includes("https://box.example.com/sandbox/callback/hcloud-deadbeef"));
checkT("cloud-init agent contains auth token", decoded.includes("sekret"));
checkT("cloud-init installs curl+ufw", ci.includes("curl") && ci.includes("ufw"));
checkT("cloud-init agent powers off", decoded.includes("poweroff"));
checkT("cloud-init agent locks egress (ufw default deny outgoing)", decoded.includes("default deny outgoing"));
// the raw command + token must NOT appear un-encoded (they live base64 in write_files)
checkT("cloud-init does not leak raw destructive command", !ci.includes("rm -rf /"));
checkT("cloud-init does not leak auth token in plaintext", !ci.includes("sekret"));
// validate the produced YAML parses
const py = spawnSync("python3", ["-c", "import yaml,sys; yaml.safe_load(sys.stdin.read()); print('OK')"], { input: ci, encoding: "utf-8" });
checkT("cloud-init parses as valid YAML", (py.stdout ?? "").trim() === "OK", `py stderr=${py.stderr}`);

console.log(`\nselftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
