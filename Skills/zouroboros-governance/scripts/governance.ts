#!/usr/bin/env bun
/**
 * Zouroboros Governance — external governance layer for the agent stack.
 *
 * R1 acceptance criteria (Projects/zouroboros-governance-safety/PROJECT_PLAN.md):
 *   1) Scope restriction — this CLI exposes ONLY read + verdict commands.
 *      Mutating-tool calls are gated by a mechanical BLOCKED_TOOLS list; any
 *      attempt to dispatch a write produces a typed error and an audit entry.
 *   2) Audit log — durable append-only records share the anchored schema in
 *      governance-ledger.ts. `verify` checks both the chain and detached MAC.
 *   3) Override authority — a BLOCK verdict halts the agent plane; bypassing
 *      requires signed, scoped, non-replayable authorization evidence.
 *
 * Read-only by construction: the only tools we touch are fs (logs), crypto
 * (hashing), and stdout. No fetch, no shell-out to writes.
 *
 * Wired callers in this session:
 *   - Skills/consensus-gate/scripts/consensus-gate.ts — `--escalate` on split
 *     verdicts records a `consensus-escalation` entry here. The returned
 *     verdict_id back-references onto the consensus record.
 *
 * Additional callers:
 *   - autonomy-pretool-adapter.ts — shadow-only pre-action classification
 *   - pre-merge-gate
 *   - autoloop campaign STaR mutations
 */
import { parseArgs } from "util";
import { randomUUID } from "node:crypto";
import {
  appendAuditRecord,
  canonicalStringify,
  ledgerPaths,
  sha256,
  tailAuditRecords,
  verifyLedger,
  type AuditRecord,
} from "./governance-ledger";
import {
  consumeAuthorization,
  readAuthorizationFile,
  verifyAuthorization,
  type AuthorizationEvidence,
} from "./autonomy-authorization";

export const BLOCKED_TOOLS: readonly string[] = Object.freeze([
  // The governance persona must never invoke these tool kinds. Mechanical
  // enforcement: if a dispatch path here ever tries to call one of these, we
  // throw and log a `blocked-tool-attempt` entry instead. Listed by family.
  "send_email_to_user",
  "send_sms_to_user",
  "write_space_route",
  "edit_space_route",
  "delete_space_route",
  "update_user_service",
  "register_user_service",
  "delete_user_service",
  "create_agent",
  "edit_agent",
  "delete_agent",
  "publish_site",
  "edit_file",
  "edit_file_llm",
  "create_or_rewrite_file",
  "run_bash_command",
  "run_sequential_cmds",
  "run_parallel_cmds",
  "use_app_gmail", // send-side
  "create_stripe_payment_link",
  "set_active_persona",
  "create_rule",
  "edit_rule",
  "delete_rule",
]);

export type GovernanceVerdict = "ALLOW" | "BLOCK" | "ADVISORY";

interface AuditPayloadVerdict {
  verdict_id: string;
  kind: string;
  label: string;
  verdict: GovernanceVerdict;
  evidence: unknown;
  rationale?: string;
}

interface AuditPayloadBypass {
  bypass_id: string;
  target_verdict_id: string;
  reason: string;
  request_fingerprint: string;
  approving_authority: string;
  authorization_nonce: string;
}

interface AuditPayloadBlocked {
  attempted_tool: string;
  caller: string;
  request_fingerprint: string;
}

/**
 * The mechanical gate. Anywhere in this script that might dispatch a tool
 * MUST first call this. Any caller passing a BLOCKED_TOOLS entry trips the
 * gate, gets a logged `blocked-tool-attempt`, and gets an error.
 */
export function guardToolCall(tool: string, caller: string, requestFingerprint: string): void {
  if (BLOCKED_TOOLS.includes(tool)) {
    if (!requestFingerprint.trim()) throw new Error("Governance: blocked tool calls require a request fingerprint.");
    appendAuditRecord("blocked-tool-attempt", {
      attempted_tool: tool,
      caller,
      request_fingerprint: requestFingerprint,
    } satisfies AuditPayloadBlocked, {
      idempotencyKey: `blocked-tool-attempt:${requestFingerprint}`,
    });
    throw new Error(
      `Governance: tool '${tool}' is in BLOCKED_TOOLS and cannot be invoked by the governance persona (caller=${caller}).`
    );
  }
}

function recordVerdict(opts: {
  kind: string;
  label: string;
  verdict: GovernanceVerdict;
  evidence: unknown;
  rationale?: string;
}): AuditRecord {
  const verdict_id = `gov-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return appendAuditRecord("verdict", {
    verdict_id,
    kind: opts.kind,
    label: opts.label,
    verdict: opts.verdict,
    evidence: opts.evidence,
    rationale: opts.rationale,
  } satisfies AuditPayloadVerdict).record;
}

export function bypassRequestFingerprint(targetVerdictId: string, reason: string): string {
  return sha256(canonicalStringify({
    action: "governance.bypass",
    target_verdict_id: targetVerdictId,
    reason,
  }));
}

export function recordAuthorizedBypass(opts: {
  target_verdict_id: string;
  reason: string;
  actor: string;
  authorization: AuthorizationEvidence;
}): AuditRecord {
  const requestFingerprint = bypassRequestFingerprint(opts.target_verdict_id, opts.reason);
  const authorization = verifyAuthorization(opts.authorization, {
    actor: opts.actor,
    action: "governance.bypass",
    resource: opts.target_verdict_id,
    requestFingerprint,
    scope: "governance.bypass",
  }, { requireUnused: false });
  if (!authorization.valid) throw new Error(`Governance: bypass authorization rejected: ${authorization.reason}`);

  const bypass_id = `byp-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payload = {
    bypass_id,
    target_verdict_id: opts.target_verdict_id,
    reason: opts.reason,
    request_fingerprint: requestFingerprint,
    approving_authority: opts.authorization.approving_authority,
    authorization_nonce: opts.authorization.nonce,
  } satisfies AuditPayloadBypass;
  const result = consumeAuthorization(opts.authorization, {
    kind: "bypass",
    payload,
    idempotencyKey: `bypass:${requestFingerprint}`,
  });
  if (!result.related) throw new Error("Governance: bypass audit record was not created");
  return result.related;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      kind: { type: "string" as const, default: "manual" },
      label: { type: "string" as const, default: "unlabeled" },
      verdict: { type: "string" as const, default: "ADVISORY" },
      evidence: { type: "string" as const, default: "{}" },
      rationale: { type: "string" as const },
      target: { type: "string" as const },
      reason: { type: "string" as const },
      actor: { type: "string" as const },
      authorization: { type: "string" as const },
      limit: { type: "string" as const, default: "10" },
      json: { type: "boolean" as const, default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0] || "help";

  switch (command) {
    case "verdict": {
      let evidence: unknown = values.evidence;
      try { evidence = JSON.parse(values.evidence || "{}"); } catch { /* keep raw string */ }
      const verdict = (values.verdict || "ADVISORY").toUpperCase() as GovernanceVerdict;
      if (!["ALLOW", "BLOCK", "ADVISORY"].includes(verdict)) {
        console.error(`Invalid --verdict (must be ALLOW|BLOCK|ADVISORY)`);
        process.exit(2);
      }
      const rec = recordVerdict({
        kind: values.kind || "manual",
        label: values.label || "unlabeled",
        verdict,
        evidence,
        rationale: values.rationale,
      });
      const payload = rec.payload as AuditPayloadVerdict;
      if (values.json) {
        console.log(JSON.stringify({ verdict_id: payload.verdict_id, ts: rec.ts, this_hash: rec.this_hash }));
      } else {
        console.log(`✅ Recorded verdict`);
        console.log(`   verdict_id: ${payload.verdict_id}`);
        console.log(`   kind:       ${payload.kind}`);
        console.log(`   label:      ${payload.label}`);
        console.log(`   verdict:    ${payload.verdict}`);
        console.log(`   this_hash:  ${rec.this_hash.slice(0, 16)}…`);
      }
      break;
    }

    case "bypass": {
      if (!values.target || !values.reason || !values.actor || !values.authorization) {
        console.error("bypass requires --target <verdict_id> --reason <string> --actor <actor> --authorization <file>");
        process.exit(2);
      }
      const rec = recordAuthorizedBypass({
        target_verdict_id: values.target,
        reason: values.reason,
        actor: values.actor,
        authorization: readAuthorizationFile(values.authorization),
      });
      const payload = rec.payload as AuditPayloadBypass;
      if (values.json) {
        console.log(JSON.stringify({ bypass_id: payload.bypass_id, ts: rec.ts, this_hash: rec.this_hash }));
      } else {
        console.log(`⚠️ Recorded bypass`);
        console.log(`   bypass_id:  ${payload.bypass_id}`);
        console.log(`   target:     ${payload.target_verdict_id}`);
        console.log(`   reason:     ${payload.reason}`);
      }
      break;
    }

    case "verify": {
      const report = verifyLedger();
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Chain ${report.ok ? "✅ OK" : "❌ BROKEN"} — ${report.count} record(s)`);
        console.log(`   verdicts:          ${report.verdict_count}`);
        console.log(`   bypasses:          ${report.bypass_count}`);
        console.log(`   blocked attempts:  ${report.blocked_attempts}`);
        if (!report.ok) console.log(`   first broken link: index ${report.first_broken}`);
      }
      if (!report.ok) process.exit(1);
      break;
    }

    case "tail": {
      const limit = parseInt(values.limit || "10", 10);
      const records = tailAuditRecords(limit);
      if (values.json) {
        console.log(JSON.stringify(records, null, 2));
      } else {
        for (const r of records) {
          const head = JSON.stringify(r.payload).slice(0, 100);
          console.log(`${r.ts}  ${r.kind.padEnd(22)}  ${head}…`);
        }
      }
      break;
    }

    case "blocked-tools": {
      if (values.json) {
        console.log(JSON.stringify({ blocked_tools: BLOCKED_TOOLS }, null, 2));
      } else {
        console.log("Mechanically blocked tools (governance persona scope restriction):\n");
        for (const t of BLOCKED_TOOLS) console.log(`  - ${t}`);
      }
      break;
    }

    case "test-guard": {
      // Internal self-test: prove the gate actually rejects a blocked tool.
      try {
        const fingerprint = sha256(canonicalStringify({ command: "test-guard", caller: "test-guard-cli" }));
        guardToolCall("send_email_to_user", "test-guard-cli", fingerprint);
        console.error("❌ guardToolCall did not throw — gate is BROKEN");
        process.exit(1);
      } catch (err: any) {
        console.log(`✅ Gate rejected send_email_to_user: ${err.message}`);
        const report = verifyLedger();
        console.log(`   chain still OK: ${report.ok}, blocked_attempts=${report.blocked_attempts}`);
      }
      break;
    }

    default:
      console.log(`
zouroboros-governance — external governance layer (R1)

Usage:
  governance.ts verdict   --kind <kind> --label <label> --verdict ALLOW|BLOCK|ADVISORY [--evidence '<json>'] [--rationale <text>] [--json]
  governance.ts bypass    --target <verdict_id> --reason <text> --actor <actor> --authorization <file> [--json]
  governance.ts verify    [--json]
  governance.ts tail      [--limit 10] [--json]
  governance.ts blocked-tools [--json]
  governance.ts test-guard

Audit log:  ${ledgerPaths().audit}
Scope:      READ-ONLY persona. Mutating tools are mechanically blocked (see 'blocked-tools').
`);
      break;
  }

  // Print verdict_id in a parseable form for upstream callers like
  // consensus-gate. We emit it on a dedicated stdout line so /verdict_id:\s/
  // regex can capture it regardless of --json mode.
  if (command === "verdict") {
    const tail = tailAuditRecords(1)[0];
    if (tail && tail.kind === "verdict") {
      const p = tail.payload as AuditPayloadVerdict;
      console.log(`verdict_id: ${p.verdict_id}`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`governance error: ${err.message}`);
    process.exit(1);
  });
}
