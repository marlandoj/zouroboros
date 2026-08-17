import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_PATH,
  activateReceiptShadowAuthority,
  configHash,
  divergenceFrom,
  exportEnvLines,
  FLAG_SCHEMA,
  loadRuntimeConfig,
  loadReceiptShadowExternalConfig,
  recordTick,
  receiptShadowExternalConfigHash,
  rollbackConfig,
  receiptShadowRuntimeConfigHash,
  rollbackReceiptShadowAuthority,
  type RuntimeConfigFile,
  runtimeConfigSnapshot,
  setFlag,
  validateConfig,
  validateReceiptShadowExternalConfig,
  type ReceiptShadowExternalConfig,
} from "./runtime-config";

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr02-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function validConfig(): RuntimeConfigFile {
  const flags: Record<string, string> = {};
  for (const [key, spec] of Object.entries(FLAG_SCHEMA)) {
    if (spec.kind === "bool01") flags[key] = "1";
    else if (spec.kind === "enum") flags[key] = spec.values[0];
    else if (spec.kind === "int") flags[key] = String(spec.min);
    else if (spec.kind === "sha256") flags[key] = "a".repeat(64);
    else if (spec.kind === "uuid") flags[key] = "7760679f-6ac8-461c-a567-43fae21c3eee";
    else flags[key] = "/tmp/fixture";
  }
  flags.FACTORY_RECEIPT_SHADOW_MODE = "off";
  flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "0".repeat(64);
  flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = "0".repeat(64);
  return { version: 1, updated_at: "2026-08-07T00:00:00.000Z", updated_by: "fixture", flags };
}

function writeConfig(dir: string, cfg: RuntimeConfigFile): string {
  const p = join(dir, "runtime-flags.json");
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function receiptConfig(overrides: Partial<ReceiptShadowExternalConfig> = {}): ReceiptShadowExternalConfig {
  const value: ReceiptShadowExternalConfig = {
    contract_id: "zouroboros-run-receipt-shadow-config/v1",
    version: 1,
    updated_at: "2026-08-11T00:00:00.000Z",
    updated_by: "test",
    mode: "off",
    activation_manifest_sha256: "0".repeat(64),
    effective_config_sha256: "0".repeat(64),
    automation_id: "7760679f-6ac8-461c-a567-43fae21c3eee",
    runtime: "zo-native",
    policy_path: "/home/workspace/Skills/zouroboros-governance/config/autonomy-policy.json",
    policy_sha256: "a".repeat(64),
    database_path: "/home/workspace/.runtime/evidence-substrate/state/run-receipt-shadow.sqlite",
    registry_path: "/home/workspace/.runtime/evidence-substrate/config/run-receipt-shadow-adapters.json",
    registry_sha256: "b".repeat(64),
    cohort_amendment_sha256: "c".repeat(64),
    qualification_window_days: 225,
    required_operations_per_class: 30,
    max_plans_per_harvest: 12,
    max_database_bytes: 64 * 1024 * 1024,
    write_high_water_bytes: 56 * 1024 * 1024,
    github_readback_enabled: true,
    ...overrides,
  };
  if (value.mode === "shadow" && !("effective_config_sha256" in overrides)) {
    value.effective_config_sha256 = receiptShadowExternalConfigHash(value);
  }
  return value;
}

describe("typed validation (fail closed)", () => {
  test("a fully valid config loads with a hash", () => {
    const p = writeConfig(tempDir(), validConfig());
    const r = loadRuntimeConfig(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("missing file fails closed", () => {
    const r = loadRuntimeConfig(join(tempDir(), "nope.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("missing config file");
  });

  test("unparseable JSON fails closed", () => {
    const d = tempDir();
    const p = join(d, "runtime-flags.json");
    writeFileSync(p, "{ not json");
    expect(loadRuntimeConfig(p).ok).toBe(false);
  });

  test("unknown flag is rejected, never a silent no-op", () => {
    const cfg = validConfig();
    (cfg.flags as Record<string, string>).SF999_TYPO = "1";
    const { errors } = validateConfig(cfg);
    expect(errors.join(" ")).toContain("SF999_TYPO");
    expect(errors.join(" ")).toContain("unknown flag");
  });

  test("bad enum and bad bool values are rejected", () => {
    const cfg = validConfig();
    cfg.flags.SF003_POOL_MODE = "yolo";
    cfg.flags.SF010_AUTOMERGE = "true";
    const { errors } = validateConfig(cfg);
    expect(errors.some((e) => e.startsWith("SF003_POOL_MODE"))).toBe(true);
    expect(errors.some((e) => e.startsWith("SF010_AUTOMERGE"))).toBe(true);
  });

  test("persona routing is typed and defaults must be explicit", () => {
    const cfg = validConfig();
    cfg.flags.FACTORY_PERSONA_ROUTING_MODE = "shadow";
    expect(validateConfig(cfg).errors).toEqual([]);
    cfg.flags.FACTORY_PERSONA_ROUTING_MODE = "active";
    expect(validateConfig(cfg).errors.join(" ")).toContain("FACTORY_PERSONA_ROUTING_MODE");
  });

  test("authority bindings require exact lowercase SHA-256 digests", () => {
    const cfg = validConfig();
    cfg.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "abc";
    cfg.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = "A".repeat(64);
    const { errors } = validateConfig(cfg);
    expect(errors.filter((error) => error.includes("SHA-256"))).toHaveLength(2);
  });

  test("receipt authority tuple is complete in both off and shadow modes", () => {
    const cfg = validConfig();
    cfg.flags.FACTORY_RECEIPT_SHADOW_MODE = "shadow";
    expect(validateConfig(cfg).errors.join(" ")).toContain("requires nonzero");
    cfg.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "a".repeat(64);
    cfg.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = "b".repeat(64);
    expect(validateConfig(cfg).errors).toEqual([]);
    cfg.flags.FACTORY_RECEIPT_SHADOW_MODE = "off";
    expect(validateConfig(cfg).errors.join(" ")).toContain("requires zero");
  });

  test("a missing schema flag is an error — every flag must be explicit", () => {
    const cfg = validConfig();
    delete (cfg.flags as Record<string, string>).SF010_AUTOMERGE;
    const { errors } = validateConfig(cfg);
    expect(errors.join(" ")).toContain("SF010_AUTOMERGE: missing");
  });

  test("secret-like flag names are forbidden", () => {
    const cfg = validConfig();
    (cfg.flags as Record<string, string>).FACTORY_API_KEY = "abc";
    const { errors } = validateConfig(cfg);
    expect(errors.join(" ")).toContain("secret-like");
  });
});

describe("hash and divergence", () => {
  test("hash is stable under key reordering", () => {
    const flags = { B: "1", A: "0" };
    expect(configHash(flags)).toBe(configHash({ A: "0", B: "1" }));
    expect(configHash(flags)).not.toBe(configHash({ A: "1", B: "1" }));
  });

  test("divergence flags env values that differ; unset env is not divergent", () => {
    const cfg = validConfig();
    cfg.flags.SF010_AUTOMERGE = "0";
    cfg.flags.SF006_DEDUP = "1";
    const env = { SF010_AUTOMERGE: "1" } as Record<string, string | undefined>;
    const div = divergenceFrom(cfg, env);
    expect(div.length).toBe(1);
    expect(div[0].flag).toBe("SF010_AUTOMERGE");
    expect(div[0].env_value).toBe("1");
    expect(div[0].config_value).toBe("0");
  });

  test("receipt shadow hash binds effective flags without a self-reference", () => {
    const path = writeConfig(tempDir(), validConfig());
    const base = {
      FACTORY_RECEIPT_SHADOW_MODE: "shadow",
      FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: "b".repeat(64),
      FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: "c".repeat(64),
    };
    const first = receiptShadowRuntimeConfigHash(base, path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptShadowRuntimeConfigHash({ ...base, FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: "d".repeat(64) }, path)).toBe(first);
    expect(receiptShadowRuntimeConfigHash({ ...base, FACTORY_RECEIPT_SHADOW_MODE: "off" }, path)).not.toBe(first);
  });
});

describe("external receipt shadow config", () => {
  test("accepts the frozen off target and uses a self-reference-free hash", () => {
    const targetPath = join(import.meta.dir, "..", "config", "run-receipt-shadow-runtime.json");
    const loaded = loadReceiptShadowExternalConfig(targetPath);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.mode).toBe("off");
      expect(loaded.config.activation_manifest_sha256).toBe("0".repeat(64));
      expect(loaded.effectiveHash).toBe(receiptShadowExternalConfigHash(loaded.config));
    }
  });

  test("rejects unknown fields, invalid paths, bounds, modes, and authority hashes", () => {
    const unknown = { ...receiptConfig(), typo: true };
    expect(validateReceiptShadowExternalConfig(unknown)).toMatchObject({ ok: false });
    const invalid = receiptConfig({
      mode: "enforce" as never,
      policy_path: "relative.json",
      max_plans_per_harvest: 13,
      automation_id: "not-a-uuid",
      policy_sha256: "A".repeat(64),
    });
    const result = validateReceiptShadowExternalConfig(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("expected off or shadow");
      expect(result.errors.join(" ")).toContain("expected absolute path");
      expect(result.errors.join(" ")).toContain("expected integer");
      expect(result.errors.join(" ")).toContain("expected lowercase UUID");
      expect(result.errors.join(" ")).toContain("expected lowercase SHA-256");
    }
    expect(loadReceiptShadowExternalConfig(`${tempDir()}/../config.json`)).toMatchObject({ ok: false });
  });

  test("requires a nonzero activation hash and exact effective hash in shadow mode", () => {
    expect(validateReceiptShadowExternalConfig(receiptConfig({ mode: "shadow", activation_manifest_sha256: "0".repeat(64) }))).toMatchObject({ ok: false });
    const active = receiptConfig({ mode: "shadow", activation_manifest_sha256: "d".repeat(64) });
    expect(validateReceiptShadowExternalConfig(active)).toMatchObject({ ok: true });
    expect(validateReceiptShadowExternalConfig({ ...active, effective_config_sha256: "e".repeat(64) })).toMatchObject({ ok: false });
  });

  test("rejects traversal, immutable-runtime, system, and noncanonical paths", () => {
    const invalidPaths = [
      "/",
      "/etc/passwd",
      "/home/workspace/.runtime/evidence-substrate/state/../config/receipt.sqlite",
      "/home/workspace/.runtime/factory-conveyor-deadbeef/run-receipt-shadow.sqlite",
      "/home/workspace/.runtime/evidence-substrate/state/run-receipt-shadow.sqlite\0tail",
    ];
    for (const database_path of invalidPaths) {
      expect(validateReceiptShadowExternalConfig(receiptConfig({ database_path }))).toMatchObject({ ok: false });
    }
    expect(validateReceiptShadowExternalConfig(receiptConfig({ policy_path: "/home/workspace/.runtime/factory-conveyor-deadbeef/autonomy-policy.json" }))).toMatchObject({ ok: false });
    expect(validateReceiptShadowExternalConfig(receiptConfig({ registry_path: "/tmp/run-receipt-shadow-adapters.json" }))).toMatchObject({ ok: false });
  });
});

describe("atomic set and rollback", () => {
  test("set bumps version, preserves previous, rollback restores it", () => {
    const d = tempDir();
    const configPath = writeConfig(d, validConfig());
    const previousPath = join(d, "runtime-flags.previous.json");

    const set = setFlag("SF010_AUTOMERGE", "0", "test-operator", { configPath, previousPath });
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.config.version).toBe(2);
      expect(set.config.flags.SF010_AUTOMERGE).toBe("0");
    }
    const prev = JSON.parse(readFileSync(previousPath, "utf-8")) as RuntimeConfigFile;
    expect(prev.version).toBe(1);
    expect(prev.flags.SF010_AUTOMERGE).toBe("1");

    const rb = rollbackConfig("test-operator", { configPath, previousPath });
    expect(rb.ok).toBe(true);
    if (rb.ok) {
      expect(rb.config.flags.SF010_AUTOMERGE).toBe("1");
      expect(rb.config.version).toBe(3);
      expect(rb.config.updated_by).toContain("rollback");
    }
  });

  test("set rejects invalid values and unknown keys without touching the file", () => {
    const d = tempDir();
    const configPath = writeConfig(d, validConfig());
    const before = readFileSync(configPath, "utf-8");
    expect(setFlag("SF010_AUTOMERGE", "maybe", "t", { configPath, previousPath: join(d, "p.json") }).ok).toBe(false);
    expect(setFlag("NOT_A_FLAG", "1", "t", { configPath, previousPath: join(d, "p.json") }).ok).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("rollback without a previous config fails loudly", () => {
    const d = tempDir();
    const configPath = writeConfig(d, validConfig());
    const rb = rollbackConfig("t", { configPath, previousPath: join(d, "missing.json") });
    expect(rb.ok).toBe(false);
  });

  test("receipt shadow authority activates one typed tuple and restores the exact off preimage", () => {
    const d = tempDir();
    const externalRoot = join(d, "receipt");
    mkdirSync(externalRoot);
    const policyPath = join(externalRoot, "autonomy-policy.json");
    const databasePath = join(externalRoot, "run-receipt-shadow.sqlite");
    const registryPath = join(externalRoot, "run-receipt-shadow-adapters.json");
    const external = receiptConfig({
      mode: "shadow",
      activation_manifest_sha256: "d".repeat(64),
      policy_path: policyPath,
      database_path: databasePath,
      registry_path: registryPath,
    });
    const externalPath = join(externalRoot, "run-receipt-shadow-runtime.json");
    writeFileSync(externalPath, `${JSON.stringify(external, null, 2)}\n`);

    const config = validConfig();
    config.flags.FACTORY_RECEIPT_SHADOW_MODE = "off";
    config.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "0".repeat(64);
    config.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = "0".repeat(64);
    config.flags.FACTORY_RECEIPT_SHADOW_AUTOMATION_ID = external.automation_id;
    config.flags.FACTORY_RECEIPT_SHADOW_DB_PATH = databasePath;
    config.flags.FACTORY_RECEIPT_SHADOW_REGISTRY_PATH = registryPath;
    const configPath = writeConfig(d, config);
    const previousPath = join(d, "runtime-flags.previous.json");
    const exactOffPreimage = readFileSync(configPath, "utf8");

    const activated = activateReceiptShadowAuthority(externalPath, "operator", {
      configPath,
      previousPath,
      externalConfigOptions: { testRoot: d },
    });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.changed).toBe(true);
    expect(activated.config.version).toBe(config.version + 1);
    expect(activated.config.flags.FACTORY_RECEIPT_SHADOW_MODE).toBe("shadow");
    expect(activated.config.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH).toBe(external.activation_manifest_sha256);
    expect(activated.config.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH).toBe(external.effective_config_sha256);
    expect(readFileSync(previousPath, "utf8")).toBe(exactOffPreimage);
    expect(divergenceFrom(activated.config, { ...activated.config.flags })).toEqual([]);

    const idempotent = activateReceiptShadowAuthority(externalPath, "operator", {
      configPath,
      previousPath,
      externalConfigOptions: { testRoot: d },
    });
    expect(idempotent).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(previousPath, "utf8")).toBe(exactOffPreimage);

    const rolledBack = rollbackReceiptShadowAuthority("operator", { configPath, previousPath });
    expect(rolledBack.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(exactOffPreimage);
    expect(readFileSync(previousPath, "utf8")).toBe(exactOffPreimage);
  });

  test("receipt shadow authority rejects invalid, mismatched, and partial bindings without writes", () => {
    const d = tempDir();
    const externalRoot = join(d, "receipt");
    mkdirSync(externalRoot);
    const external = receiptConfig({
      mode: "shadow",
      activation_manifest_sha256: "d".repeat(64),
      policy_path: join(externalRoot, "policy.json"),
      database_path: join(externalRoot, "receipts.sqlite"),
      registry_path: join(externalRoot, "registry.json"),
    });
    const externalPath = join(externalRoot, "runtime.json");
    writeFileSync(externalPath, `${JSON.stringify(external, null, 2)}\n`);
    const config = validConfig();
    config.flags.FACTORY_RECEIPT_SHADOW_MODE = "off";
    config.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "0".repeat(64);
    config.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = "0".repeat(64);
    config.flags.FACTORY_RECEIPT_SHADOW_AUTOMATION_ID = external.automation_id;
    config.flags.FACTORY_RECEIPT_SHADOW_DB_PATH = external.database_path;
    config.flags.FACTORY_RECEIPT_SHADOW_REGISTRY_PATH = "/wrong/registry.json";
    const configPath = writeConfig(d, config);
    const previousPath = join(d, "previous.json");
    const before = readFileSync(configPath, "utf8");
    const mismatch = activateReceiptShadowAuthority(externalPath, "operator", {
      configPath,
      previousPath,
      externalConfigOptions: { testRoot: d },
    });
    expect(mismatch.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(existsSync(previousPath)).toBe(false);

    config.flags.FACTORY_RECEIPT_SHADOW_REGISTRY_PATH = external.registry_path;
    config.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "e".repeat(64);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const partialBefore = readFileSync(configPath, "utf8");
    const partial = activateReceiptShadowAuthority(externalPath, "operator", {
      configPath,
      previousPath,
      externalConfigOptions: { testRoot: d },
    });
    expect(partial.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(partialBefore);
    expect(existsSync(previousPath)).toBe(false);

    const invalidExternal = { ...external, effective_config_sha256: "f".repeat(64) };
    writeFileSync(externalPath, `${JSON.stringify(invalidExternal, null, 2)}\n`);
    expect(activateReceiptShadowAuthority(externalPath, "operator", {
      configPath,
      previousPath,
      externalConfigOptions: { testRoot: d },
    }).ok).toBe(false);
  });
});

describe("tick recording (conveyor evidence)", () => {
  test("a valid config records hash + effective values", () => {
    const d = tempDir();
    const configPath = writeConfig(d, validConfig());
    const ticksPath = join(d, "config-ticks.jsonl");
    const rec = recordTick("test-cycle", configPath, ticksPath);
    expect(rec.valid).toBe(true);
    expect(rec.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rec.effective?.SF010_AUTOMERGE).toBeDefined();
    const line = JSON.parse(readFileSync(ticksPath, "utf-8").trim());
    expect(line.source).toBe("test-cycle");
    expect(line.hash).toBe(rec.hash);
  });

  test("an invalid config records valid:false with errors instead of throwing", () => {
    const d = tempDir();
    const ticksPath = join(d, "config-ticks.jsonl");
    const rec = recordTick("test-cycle", join(d, "missing.json"), ticksPath);
    expect(rec.valid).toBe(false);
    expect(rec.errors.length).toBeGreaterThan(0);
    expect(readFileSync(ticksPath, "utf-8")).toContain('"valid":false');
  });
});

describe("cross-process boundary proof", () => {
  test("exported flags survive into a spawned child process", async () => {
    const cfg = validConfig();
    cfg.flags.SF010_AUTOMERGE = "0";
    cfg.flags.SF003_POOL_MODE = "act";
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const line of exportEnvLines(cfg)) {
      const m = line.match(/^export ([A-Z0-9_]+)='(.*)'$/);
      expect(m).not.toBeNull();
      if (m) env[m[1]] = m[2].replace(/'\\''/g, "'");
    }
    const proc = Bun.spawn(
      ["bun", "-e", "console.log(JSON.stringify({a: process.env.SF010_AUTOMERGE, b: process.env.SF003_POOL_MODE, c: process.env.PLAN_GATE_LEDGER_PATH}))"],
      { env, stdout: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const child = JSON.parse(out.trim());
    expect(child.a).toBe("0");
    expect(child.b).toBe("act");
    expect(child.c).toBe("/tmp/fixture");
  });

  test("shell round-trip: eval export-env then check reports clean", async () => {
    const script = `eval "$(bun ${join(import.meta.dir, "runtime-config.ts")} export-env)" && bun ${join(import.meta.dir, "runtime-config.ts")} check`;
    const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(out + err).toContain("clean: env matches");
  });
});

describe("live seed sanity", () => {
  test("the checked-in production seed is valid and hashes", () => {
    const r = loadRuntimeConfig(CONFIG_PATH);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.flags.SF010_AUTOMERGE).toBe("0");
      expect(r.config.flags.SF006_ENFORCE).toBe("1");
      expect(r.config.flags.FACTORY_MODEL_REVIEW).toBe("off");
    }
    const snap = runtimeConfigSnapshot(CONFIG_PATH);
    expect(snap.valid).toBe(true);
  });
});
