#!/usr/bin/env bun
// Unified daily refresh orchestrator. Refreshes every provider catalog and fans
// the result out to both consumers:
//   1. Synthetic.new  → ~/.zouroboros/synthetic-catalog.json (consensus-gate chains)
//   2. OpenRouter     → ~/.zouroboros/openrouter-catalog.json (consensus-gate chains)
//   3. tier-resolver  → data/external-models.json (advisory external pool)
//
// Emits a machine-readable summary so the scheduling agent can email only on a
// non-zero diff, a broken quorum, or a provider error.
import * as path from "path";
import {
  fetchLiveCatalog as fetchSynthetic,
  writeCache as writeSynthetic,
  loadCachedCatalog as loadSynthetic,
  diffCatalog,
  getChain,
  type CatalogCache,
  type DiffSummary,
} from "./catalog";
import {
  fetchLiveCatalog as fetchOpenRouter,
  writeCache as writeOpenRouter,
  loadCachedCatalog as loadOpenRouter,
} from "./catalog-openrouter";
import {
  fetchLiveCatalog as fetchOpencode,
  writeCache as writeOpencode,
  loadCachedCatalog as loadOpencode,
} from "./catalog-opencode";

const DEFAULT_QUORUM = [
  "hf:zai-org/GLM-5.2",
  "hf:moonshotai/Kimi-K2.7-Code",
  "hf:MiniMaxAI/MiniMax-M3",
];
const SYNC_SCRIPT = path.resolve(__dirname, "../../tier-resolver/scripts/catalog-sync.ts");

interface ProviderResult {
  provider: string;
  ok: boolean;
  modelCount: number;
  totalChanges: number;
  diff: DiffSummary | null;
  error: string | null;
}

async function refreshProvider(
  provider: string,
  load: () => CatalogCache | null,
  fetchLive: () => Promise<any[]>,
  write: (models: any[]) => CatalogCache,
): Promise<ProviderResult> {
  try {
    const prev = load();
    const models = await fetchLive();
    const next = write(models);
    const diff = diffCatalog(prev, next);
    const totalChanges =
      diff.added.length + diff.removed.length + diff.priceChanges.length + diff.chainChanges.length;
    console.log(`✅ ${provider}: cached ${models.length} models (${totalChanges} changes)`);
    if (diff.added.length) console.log(`   + ${diff.added.length} added`);
    if (diff.removed.length) console.log(`   − ${diff.removed.length} removed`);
    if (diff.priceChanges.length) console.log(`   Δ ${diff.priceChanges.length} price changes`);
    return { provider, ok: true, modelCount: models.length, totalChanges, diff, error: null };
  } catch (err: any) {
    console.error(`❌ ${provider}: ${err.message}`);
    return { provider, ok: false, modelCount: 0, totalChanges: 0, diff: null, error: err.message };
  }
}

function runTierSync(): { ok: boolean; output: string } {
  const proc = Bun.spawnSync(["bun", SYNC_SCRIPT, "sync"], { stdout: "pipe", stderr: "pipe" });
  const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  console.log(output.trim());
  return { ok: proc.exitCode === 0, output };
}

function validateQuorum(): { ok: boolean; broken: string[] } {
  const broken: string[] = [];
  for (const id of DEFAULT_QUORUM) {
    if (getChain(id).length === 0) broken.push(id);
  }
  if (broken.length) console.error(`⚠️  Broken quorum (no chain): ${broken.join(", ")}`);
  else console.log(`✅ Quorum intact: ${DEFAULT_QUORUM.length} primaries have non-empty chains`);
  return { ok: broken.length === 0, broken };
}

async function main() {
  console.log("🔄 Provider catalog refresh — all providers + consumers\n");

  const results: ProviderResult[] = [];
  results.push(
    await refreshProvider("synthetic.new", loadSynthetic, fetchSynthetic, writeSynthetic),
  );
  results.push(
    await refreshProvider("openrouter", loadOpenRouter, fetchOpenRouter, writeOpenRouter),
  );
  results.push(
    await refreshProvider("opencode", loadOpencode, fetchOpencode, writeOpencode),
  );

  console.log("");
  const tierSync = runTierSync();

  console.log("");
  const quorum = validateQuorum();

  const totalChanges = results.reduce((a, r) => a + r.totalChanges, 0);
  const providerErrors = results.filter((r) => !r.ok).map((r) => r.provider);
  const actionNeeded = totalChanges > 0 || !quorum.ok || providerErrors.length > 0 || !tierSync.ok;

  const summary = {
    action_needed: actionNeeded,
    total_changes: totalChanges,
    provider_errors: providerErrors,
    quorum_broken: quorum.broken,
    tier_sync_ok: tierSync.ok,
    providers: results.map((r) => ({
      provider: r.provider,
      ok: r.ok,
      models: r.modelCount,
      changes: r.totalChanges,
      added: r.diff?.added ?? [],
      removed: r.diff?.removed ?? [],
      price_changes: r.diff?.priceChanges.map((p) => p.id) ?? [],
    })),
  };
  console.log("\n" + JSON.stringify(summary));

  // Exit non-zero only on hard failure (provider error, broken quorum, failed
  // sync) so the agent can distinguish "informational change" from "needs help".
  if (providerErrors.length || !quorum.ok || !tierSync.ok) process.exit(1);
}

main().catch((err) => {
  console.error(`❌ orchestrator: ${err.message}`);
  process.exit(1);
});
