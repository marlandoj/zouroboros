# `audit.config.json` Schema

Optional config file the audit can read for per-repo defaults. An `audit.config.json` at the root of the audited repo is auto-discovered; an explicit `--config path/to/audit.config.json` overrides it. In both cases CLI flags win over config values.

```json
{
  "$schema": "https://example.com/production-ready-config.schema.json",
  "appName": "FooApp",
  "appPurpose": "Personal finance tracker",
  "techStack": ["next", "node", "supabase"],
  "deployment": "vercel",
  "providers": {
    "auth": "supabase-auth",
    "db": "supabase-postgres",
    "payments": "stripe"
  },
  "surfaces": {
    "userData": true,
    "uploads": false,
    "admin": true,
    "ai": true,
    "payments": true
  },
  "url": "https://staging.foo.app",
  "ignore": {
    "domains": [],
    "findingIds": [
      "frontend.internal-url.docs/example.tsx.12"
    ],
    "filePatterns": [
      "examples/**",
      "**/__fixtures__/**"
    ]
  },
  "thresholds": {
    "failOn": "high",
    "maxMedium": 5
  },
  "tools": {
    "gitleaks": { "enabled": true },
    "semgrep": { "enabled": true, "extraConfigs": ["p/python"] },
    "lighthouse": { "enabled": true, "minScore": 0.9 }
  }
}
```

## Field reference

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `appName` | string | — | Shown in report header |
| `appPurpose` | string | — | One-line description |
| `techStack` | string[] | auto-detected | Hints to the scanner |
| `deployment` | string | auto-detected | `vercel`, `netlify`, `fly.io`, etc. |
| `providers.auth` | string | — | `clerk`, `auth0`, `supabase-auth`, etc. |
| `providers.db` | string | — | `postgres`, `mysql`, `mongo`, `supabase-postgres` |
| `providers.payments` | string | — | `stripe`, `paddle`, `lemonsqueezy` |
| `surfaces.userData` | bool | false | Triggers stricter legal/data checks |
| `surfaces.uploads` | bool | false | Activates upload check |
| `surfaces.admin` | bool | false | Adds admin-path checks |
| `surfaces.ai` | bool | false | Activates LLM Top 10 checks |
| `surfaces.payments` | bool | false | Activates payments check |
| `url` | string | — | Public/staging URL for DAST |
| `ignore.domains` | string[] | [] | Skip these check domains |
| `ignore.findingIds` | string[] | [] | Suppress specific finding IDs |
| `ignore.filePatterns` | string[] | [] | Glob patterns to skip in repo scan |
| `thresholds.failOn` | severity | `critical` | Lowest severity that fails CI |
| `thresholds.maxMedium` | number | 3 | More than this medium = launch-with-monitoring |
| `tools.*.enabled` | bool | true | Disable a tool entirely |
| `tools.*.extraConfigs` | string[] | [] | Tool-specific extra config |
| `thresholds.perDomain` | map | {} | Per-domain severity floor; findings below it are dropped, e.g. `{ "frontend": "medium" }` |
| `objectives` | string[] | [] | Free-form audit objectives, echoed into the report header |
| `riskProfile` | enum | `standard` | `startup-mvp` \| `standard` \| `regulated` — tunes verdict ceilings & maxMedium default |
| `asvs.version` | string | — | OWASP ASVS version this audit targets (e.g. `4.0.3`) |
| `asvs.level` | 1\|2\|3 | — | ASVS assurance level |
| `asvs.controls` | string[] | [] | ASVS control IDs claimed in scope (e.g. `V2.1.1`) |

## Risk profiles

The `riskProfile` field tunes how aggressively coverage gaps and medium findings
cap the verdict:

| Profile | maxMedium default | Coverage-gap ceiling |
|---------|-------------------|----------------------|
| `startup-mvp` | 5 | Any gap caps at **launch-with-monitoring** (lenient, but never launch-ready while incomplete) |
| `standard` | 3 | Blocking gap → **private-beta-only**; soft gap → **launch-with-monitoring** |
| `regulated` | 1 | Any gap → **private-beta-only** (strict) |

Across every profile the core invariant holds: **an incomplete audit can never
return Launch-Ready.**

## OWASP ASVS mapping

`asvs` records which controls the audit is *expected* to cover so the report can
be read against a versioned standard. It is declarative — it does not by itself
run new checks — but it is echoed into the report header and persisted in
`findings.json` so downstream tooling can map findings to controls.

```json
{
  "riskProfile": "regulated",
  "objectives": ["SOC 2 pre-audit", "No PII in logs"],
  "asvs": { "version": "4.0.3", "level": 2, "controls": ["V2.1.1", "V3.4.1", "V7.1.1"] },
  "thresholds": { "perDomain": { "accessibility": "medium" } }
}
```
