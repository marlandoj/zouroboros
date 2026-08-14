/**
 * Domain 13: Database & Data Access
 *
 *  - Row-Level Security (Supabase/Postgres)
 *  - Parameterized queries (no SQL string concat)
 *  - Tenant scoping in queries
 *  - Anon key exposed without RLS
 */

import type { CheckModule, AuditConfig, CheckResult, Finding } from "../lib/types.ts";
import { walkRepo, grepFiles, isSource, safeRead } from "../lib/runners.ts";

interface SourceHit {
  file: string;
  line: number;
  snippet: string;
}

const SQL_STATEMENT = String.raw`(?:SELECT\s+[\s\S]{0,200}?\s+FROM|INSERT\s+INTO|UPDATE\s+[\w."'\`]+\s+SET|DELETE\s+FROM)`;
const SQL_SINK = String.raw`(?:\$?queryRawUnsafe|\$?executeRawUnsafe|query|execute|exec|raw)`;

/**
 * Find dynamic SQL only when it is passed to an execution sink. This avoids
 * treating UI copy such as `Delete ${date}` or parameterized ORM `sql` tags as
 * executable SQL while retaining the hard blocker for unsafe query calls.
 */
export function findSqlConcatenation(files: string[]): SourceHit[] {
  const interpolation = new RegExp(
    String.raw`\b${SQL_SINK}\s*\(\s*\`(?=[\s\S]{0,240}${SQL_STATEMENT})[\s\S]{0,400}?\$\{[\s\S]{0,160}?\}[\s\S]{0,400}?\``,
    "gi",
  );
  const concatenation = new RegExp(
    String.raw`\b${SQL_SINK}\s*\(\s*["'](?=[\s\S]{0,240}${SQL_STATEMENT})[\s\S]{0,400}?["']\s*\+[\s\S]{0,240}?\)`,
    "gi",
  );
  const pythonFString = new RegExp(
    String.raw`\b(?:execute|executemany)\s*\(\s*f["'](?=[\s\S]{0,240}${SQL_STATEMENT})[\s\S]{0,400}?\{[\s\S]{0,160}?\}[\s\S]{0,400}?["']`,
    "gi",
  );
  const hits: SourceHit[] = [];

  for (const file of files) {
    if (/(?:^|[\\/])(?:__tests__|tests?)(?:[\\/])|\.(?:test|spec)\.[^.]+$/i.test(file)) continue;
    const content = safeRead(file);
    if (!content) continue;
    for (const pattern of [interpolation, concatenation, pythonFString]) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(content); match && hits.length < 15; match = pattern.exec(content)) {
        const line = content.slice(0, match.index).split("\n").length;
        hits.push({
          file,
          line,
          snippet: match[0].replace(/\s+/g, " ").trim().slice(0, 240),
        });
      }
    }
    if (hits.length >= 15) break;
  }

  return hits;
}

export const databaseCheck: CheckModule = {
  domain: "database",
  description: "Audit DB access — RLS, parameterization, tenant scoping.",
  async run(config: AuditConfig): Promise<CheckResult> {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    if (!config.repoPath) return empty("database", startedAt);
    const repo = config.repoPath;
    const sourceFiles = walkRepo(repo, (rel) => isSource(rel) || /\.sql$/i.test(rel), { maxFiles: 4000 });

    // SQL injection patterns
    const sqlConcat = findSqlConcatenation(sourceFiles);
    for (const hit of sqlConcat) {
      findings.push({
        id: `db.sql-concat.${rel(hit.file, repo)}.${hit.line}`,
        domain: "database",
        severity: "critical",
        hardBlocker: true,
        title: "SQL query built via string concatenation/interpolation",
        description: "Concatenating user input into SQL is the textbook SQL-injection vector.",
        evidence: [{ file: rel(hit.file, repo), line: hit.line, snippet: hit.snippet }],
        remediation: "Use parameterised queries (`?` / `$1` placeholders) or an ORM. Never concatenate untrusted input into SQL.",
        source: "production-ready:sql-concat-grep",
        references: ["https://owasp.org/Top10/A03_2021-Injection/", "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html"],
      });
    }

    // Supabase anon-key in client + no RLS reference
    const supabaseClient = grepFiles(sourceFiles, /createClient\(.{0,80}supabase|supabase-js/, { maxMatches: 1 });
    const rlsRef = grepFiles(sourceFiles, /(ENABLE\s+ROW\s+LEVEL\s+SECURITY|row_level_security|alter\s+table.{0,30}force\s+row\s+level)/i, { maxMatches: 1 });
    if (supabaseClient.length > 0 && rlsRef.length === 0) {
      findings.push({
        id: "db.supabase-no-rls",
        domain: "database",
        severity: "critical",
        hardBlocker: true,
        title: "Supabase client used but no Row-Level Security policy detected",
        description: "When the anon key is exposed in the browser (the standard Supabase pattern), RLS is the ONLY thing preventing one user from reading every other user's row.",
        remediation: "For every table the anon key can reach: `ALTER TABLE foo ENABLE ROW LEVEL SECURITY;` then add per-row policies scoping by `auth.uid()`. Default-deny is mandatory. Verify by signing in as user A and trying to select user B's rows directly via the supabase-js client.",
        source: "production-ready:supabase-rls",
        references: ["https://supabase.com/docs/guides/auth/row-level-security"],
      });
    }

    // Tenant-scoping heuristic: queries on tables without WHERE on user_id/tenant_id
    const unscopedQueries = grepFiles(
      sourceFiles,
      /\bfrom\s+\w+\s+where\s+(?!user_id|tenant_id|owner_id|account_id|organization_id|workspace_id)/i,
      { maxMatches: 10 },
    );
    if (unscopedQueries.length > 5) {
      findings.push({
        id: "db.tenant-scoping",
        domain: "database",
        severity: "medium",
        title: `${unscopedQueries.length} queries appear to not filter by user/tenant column`,
        description: "Heuristic — queries without user_id/tenant_id/organization_id filters may be returning cross-tenant data. Review each.",
        evidence: unscopedQueries.slice(0, 5).map((h) => ({ file: rel(h.file, repo), line: h.line, snippet: h.snippet })),
        remediation: "Every query on user-owned tables must filter by the requesting user/tenant. Consider a query-builder middleware that enforces this for you.",
        source: "production-ready:tenant-scope-grep",
        references: ["https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/"],
      });
    }

    return {
      domain: "database",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      toolsUsed: ["production-ready:db-grep"],
      toolsMissing: [],
      findings,
      manualChecklist: [
        { item: "Test backup restore in a scratch environment — actually restore, don't just dump", rationale: "Backup files aren't backups; restored databases are." },
        { item: "Database admin password rotation policy + last rotation date", rationale: "Long-lived admin creds are a high-value target." },
        { item: "Audit log captures: schema changes, role grants, admin queries, data exports", rationale: "Required for SOC 2 + breach forensics." },
        { item: "Confirm migrations are idempotent and tested in CI", rationale: "AI-generated migrations frequently aren't reversible." },
      ],
    };
  },
};

function rel(full: string, root: string): string { return full.startsWith(root) ? full.slice(root.length + 1) : full; }
function empty(domain: any, startedAt: number): CheckResult { return { domain, ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt, toolsUsed: [], toolsMissing: [], findings: [], manualChecklist: [{ item: "Provide --repo to run.", rationale: "Source access required." }] }; }
