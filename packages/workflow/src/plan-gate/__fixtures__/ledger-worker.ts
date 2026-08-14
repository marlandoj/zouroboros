import { PlanGateLedger } from '../ledger.js';
import type { FindingType, LedgerRecord } from '../types.js';

const [ledgerPath, workerId, countRaw] = Bun.argv.slice(2);
if (!ledgerPath || !workerId || !countRaw) throw new Error('ledgerPath, workerId, and count are required');

const findingCounts: Record<FindingType, number> = {
  substantive: 0, infrastructure: 0, formatting: 0, out_of_scope: 0,
  provider_failure: 0, abstention: 0, malformed_output: 0,
};
const ledger = new PlanGateLedger({ ledgerPath, lockTimeoutMs: 10_000 });
for (let index = 0; index < Number(countRaw); index++) {
  const record: LedgerRecord = {
    record_id: `${workerId}-${index}`,
    artifact_sha256: 'b'.repeat(64),
    revision: 1,
    gate_run_id: `gate-${workerId}-${index}`,
    decision: 'passed',
    policy_mode: 'mandatory',
    timestamp: new Date().toISOString(),
    provider_health_summary: {},
    call_count: 0,
    cost_usd: 0,
    finding_counts: findingCounts,
  };
  ledger.append(record);
}
