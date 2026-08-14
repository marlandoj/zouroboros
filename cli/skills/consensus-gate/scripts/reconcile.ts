/**
 * Dataset reconciliation CLI for the consensus-gate judge (P1-7, zou-reconcile-p1-7).
 *
 * Two modes, both ADVISORY and ADDITIVE:
 *
 *   reconcile.ts            (read)  surface disagreement-signal candidates from the
 *                                   prod verdict stream -> reconcile-candidates.md
 *                                   (human annotation sheet) + .json sidecar with
 *                                   BLANK human fields. Labels NOTHING automatically.
 *
 *   reconcile.ts --apply            fold the human-LABELED sidecar into the held-out
 *                                   set reconciled-holdout.json (idempotent by
 *                                   source_consensus_id). NEVER mutates the
 *                                   human-verified test-cases.json.
 *
 * The pure ranking/dedup/cap logic lives in reconcile-core.ts (tested). This file
 * is only IO + formatting. consensus-gate.ts is READ-ONLY for this whole item.
 */
import {
  selectMisverdictCandidates,
  type VerdictLogLine,
  type VerdictDbRecord,
  type CalibrationCase,
  type MisverdictCandidate,
} from "./reconcile-core";

const DATA_DIR = `${import.meta.dir}/../data/calibration`;
const TEST_CASES = `${DATA_DIR}/test-cases.json`;
const OUT_MD = `${DATA_DIR}/reconcile-candidates.md`;
const OUT_JSON = `${DATA_DIR}/reconcile-candidates.json`;
const HOLDOUT = `${DATA_DIR}/reconciled-holdout.json`;

/** Stable cosmetic id from a consensus_id (e.g. cg-1782..-y4ywue -> rec-y4ywue). */
function holdoutId(consensusId: string): string {
  const tail = consensusId.split("-").pop() || consensusId;
  return `rec-${tail}`;
}

interface SidecarCandidate extends MisverdictCandidate {
  human_expected_pass: boolean | null;
  human_category: string;
  human_difficulty: string;
  human_notes: string;
  decision: "" | "include" | "skip";
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 11)}…` : id;
}

function truncate(s: string, n: number): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function renderMarkdown(
  candidates: MisverdictCandidate[],
  meta: { logLines: number; dbRecords: number; existingCases: number; topN: number },
): string {
  const lines: string[] = [];
  lines.push("# Consensus-Gate Reconciliation — Human Annotation Sheet");
  lines.push("");
  lines.push(
    "**Purpose:** these are PROD gate verdicts surfaced by *disagreement signal* " +
      "(escalate / split / dissent / merge-adjust / low-confidence) — i.e. the cases " +
      "the panel was *least sure* about. There is **no prod ground truth**, so none of " +
      "these are labeled. Your job: decide the correct verdict for the ones worth keeping.",
  );
  lines.push("");
  lines.push(
    `**Source:** ${meta.logLines} log lines, ${meta.dbRecords} db records, ` +
      `deduped against ${meta.existingCases} existing seed cases → top ${candidates.length} candidates.`,
  );
  lines.push("");
  lines.push("**How to respond:** edit the sidecar `reconcile-candidates.json` — for each");
  lines.push("candidate set `human_expected_pass` (`true`=gate should PASS, `false`=gate");
  lines.push("should FAIL) and `decision` (`include` to add to the held-out set, `skip` to");
  lines.push("drop). Optionally fill `human_category` / `human_difficulty` / `human_notes`.");
  lines.push("Then run `bun reconcile.ts --apply`.");
  lines.push("");
  lines.push(
    "> The held-out set is **never an optimizer target** (anti-Goodhart). It is used " +
      "only to validate proposed rubric rewrites — not to tune them.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("| # | id | label | signal | gate | conf | disagree | category | criteria |");
  lines.push("|---|----|-------|--------|------|------|----------|----------|----------|");
  candidates.forEach((c, i) => {
    const gate = c.gate_pass === null ? "—" : c.gate_pass ? "PASS" : "FAIL";
    const conf = c.gate_confidence === null ? "—" : c.gate_confidence.toFixed(2);
    lines.push(
      `| ${i + 1} | \`${shortId(c.source_consensus_id)}\` | ${truncate(c.label, 28)} | ` +
        `${c.signal_class} | ${gate} | ${conf} | ${c.disagreement_fraction} | ` +
        `${c.derived_category} | ${truncate(c.criteria, 36)} |`,
    );
  });
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Code under review (per candidate)");
  lines.push("");
  candidates.forEach((c, i) => {
    lines.push(`### ${i + 1}. \`${c.source_consensus_id}\` — ${c.label || "(no label)"}`);
    lines.push("");
    lines.push(
      `- signal: **${c.signal_class}** · gate verdict: ` +
        `**${c.gate_pass === null ? "escalated" : c.gate_pass ? "PASS" : "FAIL"}** ` +
        `(conf ${c.gate_confidence ?? "—"}) · panel disagreement ${c.disagreement_fraction}`,
    );
    if (c.dissenting_models.length) lines.push(`- dissenting: ${c.dissenting_models.join(", ")}`);
    if (c.merge_adjust_reason) lines.push(`- merge-adjust: ${c.merge_adjust_reason}`);
    lines.push(`- criteria: ${truncate(c.criteria, 200)}`);
    lines.push("");
    lines.push("```");
    lines.push(c.code.length > 2000 ? `${c.code.slice(0, 2000)}\n… (truncated)` : c.code);
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}

async function readJson<T>(fs: typeof import("node:fs"), path: string, fallback: T): Promise<T> {
  if (!fs.existsSync(path)) return fallback;
  return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

if (import.meta.main) {
  const fs = await import("node:fs");
  const argv = process.argv.slice(2);
  const has = (n: string) => argv.includes(n);
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const HOME = process.env.HOME || "";
  const LOG = process.env.CONSENSUS_LOG || `${HOME}/.zouroboros/consensus-gate.log`;
  const DB = process.env.CONSENSUS_DB || `${HOME}/.zouroboros/consensus-gate.json`;

  if (has("--apply")) {
    // ── T3: fold the human-labeled sidecar into the held-out set ──────────────
    if (!fs.existsSync(OUT_JSON)) {
      console.error(`✗ no annotation sidecar at ${OUT_JSON} — run \`reconcile.ts\` (read) first.`);
      process.exit(1);
    }
    const sidecar = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as {
      candidates: SidecarCandidate[];
    };
    const labeled = (sidecar.candidates || []).filter(
      (c) => c.decision === "include" && typeof c.human_expected_pass === "boolean",
    );
    if (labeled.length === 0) {
      console.error(
        "✗ no candidates marked decision='include' with a boolean human_expected_pass. " +
          "Annotate the sidecar first. (Nothing written — test-cases.json untouched.)",
      );
      process.exit(1);
    }

    const now = new Date().toISOString();
    const holdout = await readJson(fs, HOLDOUT, {
      name: "consensus-gate-reconciled-holdout-v1",
      version: "1.0.0",
      created: now,
      updated: now,
      human_verified: true,
      provenance:
        "Reconciled from PROD consensus-gate disagreements (P1-7). HELD-OUT — never an optimizer target.",
      cases: [] as Record<string, unknown>[],
    });

    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of holdout.cases) byKey.set(String(c.source_consensus_id), c);
    let added = 0;
    let updated = 0;
    for (const c of labeled) {
      const key = c.source_consensus_id;
      const rec = {
        id: holdoutId(key),
        source_consensus_id: key,
        label: c.label,
        code: c.code,
        criteria: c.criteria,
        expected_pass: c.human_expected_pass,
        category: c.human_category || c.derived_category,
        difficulty: c.human_difficulty || "unknown",
        notes: c.human_notes || "",
        gate_pass: c.gate_pass,
        signal_class: c.signal_class,
        annotated_by: arg("--by") || process.env.RECONCILE_ANNOTATOR || "marlandoj",
        annotated_at: now,
        holdout: true,
      };
      if (byKey.has(key)) updated++;
      else added++;
      byKey.set(key, rec);
    }
    holdout.cases = [...byKey.values()].sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : 1,
    );
    holdout.updated = now;
    fs.writeFileSync(HOLDOUT, `${JSON.stringify(holdout, null, 2)}\n`);
    console.log(
      `✓ held-out set ${HOLDOUT}\n  ${holdout.cases.length} cases total ` +
        `(+${added} new, ~${updated} updated). test-cases.json untouched.`,
    );
    process.exit(0);
  }

  // ── T2: read mode — surface candidates for annotation ───────────────────────
  if (!fs.existsSync(LOG)) {
    console.error(`✗ no verdict log at ${LOG}`);
    process.exit(1);
  }
  const verdictLog: VerdictLogLine[] = fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as VerdictLogLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is VerdictLogLine => x !== null);

  const dbRecords = await readJson<VerdictDbRecord[]>(fs, DB, []);
  const testCasesDoc = await readJson<{ cases?: CalibrationCase[] }>(fs, TEST_CASES, {});
  const existingCases = testCasesDoc.cases || [];

  const topN = Number(arg("--top") ?? 12);
  const lowConfThreshold = Number(arg("--low-conf") ?? 0.6);
  const candidates = selectMisverdictCandidates(verdictLog, dbRecords, existingCases, {
    topN,
    lowConfThreshold,
  });

  if (has("--json")) {
    console.log(JSON.stringify(candidates, null, 2));
    process.exit(0);
  }

  const meta = {
    logLines: verdictLog.length,
    dbRecords: dbRecords.length,
    existingCases: existingCases.length,
    topN,
  };
  const sidecar = {
    generated: new Date().toISOString(),
    source: { log: LOG, db: DB, ...meta },
    opts: { topN, lowConfThreshold, perCategoryCap: Math.max(1, Math.ceil(topN / 3)) },
    instructions:
      "For each candidate set human_expected_pass (true|false) and decision ('include'|'skip'), " +
      "then run `reconcile.ts --apply`. test-cases.json is never modified.",
    candidates: candidates.map(
      (c): SidecarCandidate => ({
        ...c,
        human_expected_pass: null,
        human_category: "",
        human_difficulty: "",
        human_notes: "",
        decision: "",
      }),
    ),
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(sidecar, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, renderMarkdown(candidates, meta));
  console.log(
    `✓ ${candidates.length} candidates surfaced from ${meta.logLines} log lines ` +
      `(${meta.dbRecords} db records, deduped vs ${meta.existingCases} seed cases).\n` +
      `  annotation sheet : ${OUT_MD}\n` +
      `  sidecar (edit me): ${OUT_JSON}\n` +
      `  then: bun reconcile.ts --apply`,
  );
}
