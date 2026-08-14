/**
 * Domain 14: AI-Generated Code Failure Modes
 *
 *  Detects common LLM-generated antipatterns:
 *   - Silent error swallowing
 *   - Fake-passing tests
 *   - Commented-out auth checks
 *   - Hardcoded fallback credentials
 *   - Prompt-injection vectors
 *   - Hand-rolled crypto
 *   - Type-checker suppressions
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource } from "../lib/runners.ts";

export const aiCodeCheck: CheckModule = {
  domain: "ai-code",
  description: "Detect AI-generated code failure modes (silent errors, fake tests, etc.).",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("ai-code", startedAt);
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel), { maxFiles: 4000 });

    type Rule = {
      id: string;
      pattern: RegExp;
      title: string;
      description: string;
      remediation: string;
      severity: "critical" | "high" | "medium" | "low";
      hardBlocker?: boolean;
      reference?: string;
    };

    const RULES: Rule[] = [
      {
        id: "silent-except-py",
        pattern: /except[^:]*:\s*(pass|continue|\.\.\.)\s*(#|$)/m,
        title: "Bare `except: pass` swallows errors",
        description: "Errors disappear silently — failures look like successes in logs.",
        remediation: "Log the exception with traceback and rethrow, or handle specific exceptions explicitly.",
        severity: "high",
      },
      {
        id: "silent-catch-js",
        pattern: /catch\s*\([^)]*\)\s*\{\s*(\}|\/\/)/,
        title: "Empty `catch` swallows errors",
        description: "JS/TS catch block is empty or comment-only — errors disappear.",
        remediation: "Log the error and either rethrow or handle it explicitly.",
        severity: "high",
      },
      {
        id: "fake-pass-test",
        pattern: /assert\s+True\b|assert\s+1\s*==\s*1|expect\(true\)\.toBe\(true\)/,
        title: "Test that always passes",
        description: "`assert True` / `expect(true).toBe(true)` does not exercise the system under test.",
        remediation: "Replace with an assertion against the system's actual output. If you don't know what to assert yet, mark the test `xfail` / `it.todo`.",
        severity: "medium",
      },
      {
        id: "skipped-test",
        pattern: /(it|test)\.(skip|todo)\(|@pytest\.mark\.skip|@unittest\.skip/,
        title: "Skipped or TODO test",
        description: "Skipped tests need a tracking issue and an expiry date.",
        remediation: "Either fix the test or remove it. Skipped tests rot.",
        severity: "low",
      },
      {
        id: "commented-auth",
        pattern: /(\/\/|#)\s*(TODO|FIXME|XXX).*\b(auth|permission|verify|validate|csrf|rate.?limit)\b/i,
        title: "TODO/FIXME on a security control",
        description: "Comments referencing auth/validation/CSRF as TODO are open bypasses if shipped.",
        remediation: "Implement before launch. If genuinely deferred, gate the feature behind a flag that's off in prod.",
        severity: "high",
      },
      {
        id: "if-false-security",
        pattern: /(if\s+False:|if\s+0:).{0,40}(auth|admin|verify|csrf)/i,
        title: "`if False:` around a security check",
        description: "Permanent dead-branch around an auth/security check — almost certainly an accidental disable.",
        remediation: "Remove the dead branch. Re-enable the check.",
        severity: "critical",
        hardBlocker: true,
      },
      {
        id: "env-fallback-literal",
        pattern: /process\.env\.[A-Z_]+\s*\|\|\s*['"][A-Za-z0-9_-]{10,}/,
        title: "Env var falling back to a literal credential",
        description: "If the env var is unset (e.g., misconfigured prod), the fallback ships a static credential.",
        remediation: "Crash on missing env vars. Never fall back to literal credentials.",
        severity: "high",
      },
      {
        id: "tls-disabled",
        pattern: /(rejectUnauthorized\s*:\s*false|verify\s*=\s*False|TLS_INSECURE|InsecureSkipVerify\s*:\s*true)/,
        title: "TLS verification disabled",
        description: "Disabled TLS verification = MITM-trivial. Usually added to make local dev work, left on in prod.",
        remediation: "Re-enable. If self-signed certs are needed in dev, gate strictly by NODE_ENV.",
        severity: "high",
      },
      {
        id: "prompt-injection",
        pattern: /(system|prompt|systemPrompt|systemMessage).{0,30}\+\s*(user|req\.body|input|userInput)/i,
        title: "Prompt-injection vector — user input concatenated into system prompt",
        description: "Direct concatenation of user input into a system prompt enables prompt-injection (OWASP LLM01).",
        remediation: "Keep system + user role boundaries (use structured messages). Sanitize user input. Add output guardrails.",
        severity: "high",
        reference: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/",
      },
      {
        id: "type-suppression",
        pattern: /\bas\s+any\b|@ts-ignore|@ts-expect-error|#\s*type:\s*ignore/,
        title: "Type-checker suppression",
        description: "`as any` / `@ts-ignore` / `# type: ignore` silences the type checker without fixing the underlying issue.",
        remediation: "Either fix the underlying type problem or add a justification comment with an issue number to track removal.",
        severity: "low",
      },
      {
        id: "hand-rolled-crypto",
        pattern: /\b(crypto\.createHash\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\()/,
        title: "Weak hash function (MD5/SHA1)",
        description: "MD5 and SHA1 are cryptographically broken. Do not use for passwords, signatures, or integrity.",
        remediation: "Use SHA-256+ for hashing, bcrypt/argon2 for passwords, HMAC-SHA256 for signing.",
        severity: "high",
        reference: "https://owasp.org/Top10/A02_2021-Cryptographic_Failures/",
      },
    ];

    for (const rule of RULES) {
      const hits = grepFiles(sourceFiles, rule.pattern, { maxMatches: rule.severity === "low" ? 8 : 20 });
      for (const hit of hits) {
        findings.push({
          id: `ai-code.${rule.id}.${rel(hit.file, repo)}.${hit.line}`,
          domain: "ai-code",
          severity: rule.severity,
          hardBlocker: rule.hardBlocker,
          title: rule.title,
          description: rule.description,
          evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet.slice(0, 200) }],
          remediation: rule.remediation,
          source: `production-ready:ai-${rule.id}`,
          references: rule.reference ? [rule.reference] : undefined,
        });
      }
    }

    return {
      domain: "ai-code",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:ai-heuristics"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Diff every AI-generated commit against the previous state — focus on what was REMOVED, not just added", rationale: "Agents commonly remove security checks during 'fixing' a test or unrelated bug." },
        { item: "Spot-check tests by running them in --watch + deliberately breaking the SUT — do the tests fail?", rationale: "Fake-passing tests reveal themselves when the code they 'test' actually breaks." },
        { item: "Inspect every `if NODE_ENV === 'production'` branch — was the security check actually wired in prod?", rationale: "AI often forgets to remove dev escape hatches." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
