/**
 * Domain 16: Concurrency & State Integrity
 *
 * The failure modes AI-generated code most reliably ships:
 *   - React effects that subscribe/poll without a cleanup → leaks, double
 *     fires, "setState on unmounted component", stale closures.
 *   - Submit handlers with no in-flight guard → double-submit → duplicate
 *     orders/charges.
 *   - Mutations (POST/PUT/PATCH/DELETE) with no idempotency key → retries and
 *     double-clicks produce duplicate side effects.
 *   - Read-modify-write on shared rows with no optimistic-lock / transaction →
 *     lost updates under concurrent writers.
 *
 * All detection is in-process static heuristics (confidence: low/medium). The
 * genuinely hard cases (ordering, multi-tab, cache coherence) are emitted as a
 * critical manual checklist because static analysis cannot confirm them.
 */

import type { CheckModule, AuditConfig, CheckResult, Finding, ManualCheckItem } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

function rel(full: string, root: string): string {
  return full.startsWith(root) ? full.slice(root.length + 1) : full;
}

export const concurrencyCheck: CheckModule = {
  domain: "concurrency",
  description: "State-integrity heuristics: effect cleanup, double-submit, idempotency, lost updates.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) {
      return {
        domain: "concurrency",
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        toolsUsed: [],
        toolsMissing: [],
        findings: [],
        manualChecklist: [{ item: "Provide --repo to run concurrency heuristics.", rationale: "Source access required." }],
        coverage: { status: "not-run", reason: "no --repo provided" },
      };
    }
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (r) => isSource(r), { maxFiles: 4000 });

    // ── 1. useEffect that subscribes/polls without a cleanup return ──
    // Heuristic: an effect body that calls setInterval/addEventListener/
    // subscribe/onSnapshot but whose body has no `return () =>` cleanup.
    const effectFiles = sourceFiles.filter((f) => /\.(t|j)sx?$/.test(f));
    let leakHits = 0;
    for (const file of effectFiles) {
      const src = safeRead(file);
      if (!src || !src.includes("useEffect")) continue;
      // Find each useEffect(() => { ... }, [...]) block, crudely.
      const effectRe = /useEffect\(\s*\(\)\s*=>\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = effectRe.exec(src))) {
        const bodyStart = m.index + m[0].length;
        const body = sliceBalanced(src, bodyStart - 1); // from the `{`
        if (!body) continue;
        const subscribes = /(setInterval|setTimeout|addEventListener|\.subscribe\(|onSnapshot\(|new WebSocket\(|\.on\()/.test(body);
        const cleansUp = /return\s*\(?\s*\)?\s*=>/.test(body) || /return\s+function/.test(body);
        if (subscribes && !cleansUp) {
          leakHits++;
          const line = src.slice(0, m.index).split("\n").length;
          findings.push({
            id: `concurrency.effect-no-cleanup.${rel(file, repo)}.${line}`,
            domain: "concurrency",
            severity: "medium",
            title: "Effect subscribes/polls without a cleanup",
            description:
              "This `useEffect` starts a timer, listener, or subscription but returns no cleanup function. On re-render or unmount the previous one keeps running — leaking memory, firing duplicate handlers, and causing `setState`-after-unmount warnings.",
            evidence: [{ file: rel(file, repo), line, snippet: firstLine(m[0]) }],
            impact: "Duplicate network calls / event handlers and memory growth in long-lived sessions; intermittent stale-state bugs that are hard to reproduce.",
            reproduction: "Mount and unmount the component several times (navigate away and back) and watch the timer/listener count or network tab keep growing.",
            confidence: "low",
            verificationStatus: "heuristic",
            remediationClass: "code-change",
            remediation:
              "Return a cleanup function from the effect that clears the timer / removes the listener / unsubscribes, e.g. `return () => clearInterval(id)`.",
            source: "production-ready:effect-cleanup",
            references: ["https://react.dev/reference/react/useEffect#connecting-to-an-external-system"],
          });
          if (leakHits >= 20) break;
        }
      }
      if (leakHits >= 20) break;
    }

    // ── 2. Submit handlers with no in-flight / disabled guard ──
    // Heuristic: an onSubmit/handleSubmit that awaits a fetch but never sets a
    // loading/submitting/disabled flag → double-submit risk.
    const submitFiles = effectFiles;
    let dsHits = 0;
    for (const file of submitFiles) {
      const src = safeRead(file);
      if (!src) continue;
      const hasSubmit = /(onSubmit|handleSubmit|handleClick)\b/.test(src);
      const awaitsMutation = /await\s+(fetch|axios|api|supabase|\w+\.(post|put|patch|delete))/i.test(src);
      const guards = /(isSubmitting|isLoading|setLoading|disabled=|submitting|inFlight|pending)/i.test(src);
      if (hasSubmit && awaitsMutation && !guards) {
        dsHits++;
        const hit = grepFiles([file], /(onSubmit|handleSubmit|handleClick)\b/)[0];
        findings.push({
          id: `concurrency.double-submit.${rel(file, repo)}`,
          domain: "concurrency",
          severity: "high",
          title: "Submit handler with no in-flight guard (double-submit risk)",
          description:
            "This component submits an async mutation but shows no sign of disabling the control or tracking an in-flight flag. A user double-click — or a slow network with an impatient user — fires the mutation twice.",
          evidence: hit ? [{ file: rel(file, repo), line: hit.line, snippet: hit.snippet }] : [{ file: rel(file, repo) }],
          impact: "Duplicate submissions: double orders, double charges, duplicate records. On payment or ledger flows this is a direct financial-integrity bug.",
          reproduction: "Throttle the network to Slow 3G, submit the form, and click the button again before the first request resolves.",
          confidence: "low",
          verificationStatus: "heuristic",
          affectedFlow: "form submission",
          remediationClass: "code-change",
          remediation:
            "Disable the control while a request is in flight (track `isSubmitting`), and make the server operation idempotent (see idempotency-key finding) so a retry is safe even if the guard is bypassed.",
          source: "production-ready:double-submit",
          references: ["https://stripe.com/docs/api/idempotent_requests"],
        });
        if (dsHits >= 15) break;
      }
    }

    // ── 3. Mutation endpoints with no idempotency key ──
    const idemManual: ManualCheckItem[] = [];
    if (config.surfaces?.payments || config.providers?.payments) {
      const paymentFiles = sourceFiles.filter((f) => /(payment|checkout|charge|order|webhook|stripe|billing)/i.test(f));
      const usesIdemKey = grepFiles(paymentFiles, /idempotency[_-]?key/i, { maxMatches: 1 }).length > 0;
      if (paymentFiles.length > 0 && !usesIdemKey) {
        findings.push({
          id: "concurrency.no-idempotency-key",
          domain: "concurrency",
          severity: "high",
          title: "Payment/mutation path with no idempotency key",
          description:
            "Payment or order code was found, but no `Idempotency-Key` usage anywhere. Network retries (and double-submits) can create duplicate charges or orders because the server has no way to recognise the retry as the same logical operation.",
          evidence: paymentFiles.slice(0, 5).map((f) => ({ file: rel(f, repo) })),
          impact: "Duplicate charges and orders on retry — customer-facing money bug and chargeback risk.",
          confidence: "medium",
          verificationStatus: "heuristic",
          affectedFlow: "checkout / payment",
          remediationClass: "code-change",
          remediation:
            "Generate an idempotency key per logical operation client-side and pass it to the provider (Stripe supports `Idempotency-Key`). For your own mutations, store the key and return the prior result on replay.",
          source: "production-ready:idempotency",
          references: ["https://stripe.com/docs/api/idempotent_requests"],
        });
      }
    }

    // ── 4. Read-modify-write with no transaction / optimistic lock ──
    // Heuristic: a SELECT followed by an UPDATE of the same table in one fn,
    // with no `transaction`/`BEGIN`/`SELECT ... FOR UPDATE`/version column.
    let rmwHits = 0;
    for (const file of sourceFiles) {
      if (rmwHits >= 10) break;
      const src = safeRead(file);
      if (!src) continue;
      const hasRead = /\b(select|findOne|findUnique|findFirst|get)\b/i.test(src);
      const hasWrite = /\b(update|save|set)\b/i.test(src);
      const guarded = /(transaction|BEGIN|FOR UPDATE|serializable|optimistic|version|rowversion|\.\$transaction)/i.test(src);
      const looksDbHeavy = /(prisma|knex|sequelize|drizzle|supabase|db\.query|pool\.query|mongoose)/i.test(src);
      if (looksDbHeavy && hasRead && hasWrite && !guarded) {
        rmwHits++;
        const hit = grepFiles([file], /\b(update|save)\b/i)[0];
        findings.push({
          id: `concurrency.lost-update.${rel(file, repo)}`,
          domain: "concurrency",
          severity: "medium",
          title: "Read-modify-write with no transaction / optimistic lock",
          description:
            "This module reads a record and later writes it back without any transaction, `SELECT … FOR UPDATE`, or version column. Two concurrent writers can each read the old value and clobber each other — a classic lost update.",
          evidence: hit ? [{ file: rel(file, repo), line: hit.line, snippet: hit.snippet }] : [{ file: rel(file, repo) }],
          impact: "Silent data loss under concurrency: balances, counters, and inventory drift when two requests race.",
          confidence: "low",
          verificationStatus: "heuristic",
          remediationClass: "code-change",
          remediation:
            "Wrap the read-modify-write in a transaction, or use an optimistic-lock version column and retry on conflict, or push the mutation into a single atomic SQL statement (`UPDATE … SET x = x + 1`).",
          source: "production-ready:lost-update",
          references: ["https://en.wikipedia.org/wiki/Write%E2%80%93write_conflict"],
        });
      }
    }

    const manualChecklist: ManualCheckItem[] = [
      {
        item: "Double-submit every create/pay/delete action (click twice fast, and retry on a flaky network) — confirm exactly one side effect",
        rationale: "Idempotency and in-flight guards can only be confirmed by exercising the real flow.",
        critical: true,
      },
      {
        item: "Open the app in two tabs, edit the same record in both, save both — confirm the second save is rejected or merged, not silently lost",
        rationale: "Lost-update / optimistic-lock behaviour is invisible to static analysis.",
        critical: true,
      },
      {
        item: "Fire two requests that depend on ordering (e.g. create then immediately update) and confirm out-of-order arrival is handled",
        rationale: "Request ordering / race conditions surface only under real latency.",
      },
      {
        item: "Trigger a provider webhook twice with the same event id — confirm the second is a no-op (dedupe by event id)",
        rationale: "Webhook redelivery is guaranteed by most providers; duplicate processing corrupts state.",
      },
      {
        item: "Kill the process mid-write (or simulate it) and confirm no partially-written / torn state remains on restart",
        rationale: "Atomic-write / crash-consistency guarantees need a fault-injection test.",
      },
      ...idemManual,
    ];

    return {
      domain: "concurrency",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:concurrency-heuristics"],
      toolsMissing: [],
      findings,
      manualChecklist,
      coverage: { status: "partial", reason: "static heuristics only; race conditions need runtime confirmation" },
    };
  },
};

/** First line of a matched snippet, trimmed. */
function firstLine(s: string): string {
  return s.split("\n")[0]!.trim();
}

/**
 * Given source and the index of an opening `{`, return the balanced block up to
 * the matching `}`. Naive brace counting (ignores braces in strings/comments,
 * which is acceptable for a heuristic). Returns null if unbalanced.
 */
function sliceBalanced(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length && i < openIdx + 4000; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}
