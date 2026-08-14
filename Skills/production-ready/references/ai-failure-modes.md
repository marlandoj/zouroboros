# AI-Generated Code Failure Modes

A taxonomy of antipatterns commonly emitted by code-generation agents.
These are not theoretical — Veracode's 2025 study found **45% of AI-generated code shipped vulnerabilities**, with error-handling gaps at roughly **2× the rate of human-written code**.

Each pattern below has a deterministic detection rule used by the `ai-code` check.

---

## 1. Silent error swallowing

The agent wraps risky code in `try`/`catch` then does nothing.

**Detection (Python):**
```bash
rg -n 'except[^:]*:\s*(pass|continue|\.\.\.)' --type py
```

**Detection (JS/TS):**
```bash
rg -n 'catch\s*\([^)]*\)\s*\{\s*\}' --type ts --type js
rg -n 'catch\s*\([^)]*\)\s*\{\s*//' --type ts --type js
```

**Why it matters:** Errors that should page on-call get hidden. Failures look like successes in logs.

**Fix:** at minimum, log the exception with context; rethrow if the caller can recover, otherwise let it bubble.

---

## 2. Fake-passing tests

Tests that always pass — `assert True`, `expect(true).toBe(true)`, `@pytest.mark.skip`, or tests that never call the system under test.

**Detection:**
```bash
rg -n 'assert\s+True\b|assert\s+1\s*==\s*1|expect\(true\)\.toBe\(true\)'
rg -n '(it|test)\.(skip|todo)\('
rg -n '@pytest\.mark\.skip|@unittest\.skip' --type py
```

**Why it matters:** CI green isn't evidence; CI green with real assertions is.

**Fix:** every test must assert against the system's actual output. Skipped tests need a tracking issue.

---

## 3. Commented-out security checks

Auth/permission/validation/CSRF gates removed during debugging and forgotten.

**Detection:**
```bash
rg -n -i '//\s*(TODO|FIXME).*\b(auth|permission|verify|validate|csrf)\b'
rg -n -i '#\s*(TODO|FIXME).*\b(auth|permission|verify|validate)\b'
rg -n -i '(if False|if 0:).*\b(auth|admin|verify)\b'
```

**Why it matters:** every commented-out auth check is a live bypass.

---

## 4. Hardcoded credentials in fallbacks

`process.env.X || "fallback-token"` — the fallback is shipped to production.

**Detection:**
```bash
rg -n -i '(api[_-]?key|secret|token|password)\s*=\s*["\x27][A-Za-z0-9_\-]{16,}'
rg -n 'process\.env\.[A-Z_]+\s*\|\|\s*["\x27]' --type js --type ts
```

**Fix:** crash on missing env vars. Never fall back to a literal credential.

---

## 5. Disabled CSRF / TLS verification

`csrf: false`, `verify=False`, `rejectUnauthorized: false`, `TLS_INSECURE=1`.

**Detection:**
```bash
rg -n -i '(csrf.*false|verify\s*=\s*False|rejectUnauthorized:\s*false|TLS_INSECURE)'
```

**Why it matters:** typically added to make local dev work; left on in prod = MITM.

---

## 6. SQL string concatenation / f-strings

```python
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
```

**Detection:**
```bash
rg -n -i '(SELECT|INSERT|UPDATE|DELETE).*\+.*req\.' --type js --type ts
rg -n -i 'f["\x27](SELECT|INSERT|UPDATE).*\{' --type py
```

**Fix:** parameterised queries always. ORMs help.

---

## 7. Missing input validation on handlers

Express / FastAPI / Next route handlers that touch `req.body` / `req.query` / `req.params` without any schema validation.

**Detection (Express/Next):**
```bash
rg -n 'req\.(body|query|params)\.[a-zA-Z_]+' --type ts -B1 -A3 | rg -v 'zod|joi|yup|valid|parse|safeParse'
```

**Fix:** validate at the boundary. Zod, joi, yup, pydantic, marshmallow.

---

## 8. Prompt injection vectors

LLM apps that concatenate user input directly into a system prompt or chain.

**Detection:**
```bash
rg -n -i '(system|prompt).*\+\s*(user|req\.body|input)'
rg -n 'f["\x27].*\{user_input\}' --type py
```

**Mitigations:** keep system + user role boundaries; sanitize user input; use output guardrails; never concatenate untrusted text into instructions.

> OWASP LLM01 (Prompt Injection) is the #1 LLM risk for 2025.

---

## 9. Secret leakage via LLM / debug logs

Prompts often contain auth headers, request bodies, or API keys. If those get sent to an LLM (telemetry, observability, "improve our AI") or logged at INFO, they're now somewhere they shouldn't be.

**Detection:**
```bash
rg -n -i 'log.*(prompt|messages|request_body|api_key|authorization)'
```

**Fix:** redact `Authorization`, cookies, body fields named `password`/`token`/`secret`/`api_key` before logging.

---

## 10. Excessive agent permissions (LLM06)

An LLM agent has tools that can:
- send email / SMS / Slack
- transfer funds / create payment intents
- execute shell / SQL
- delete data
- modify production config

…without human approval gates.

**Detection:** manual — read the agent's tool list. The `ai-code` check flags any imports of `child_process.exec`, `subprocess.run`, `os.system` inside files that also reference LLM SDKs.

**Fix:** principle-of-least-tool. Approval gating on destructive actions. Rate-limit agent loops.

---

## 11. Unbounded LLM consumption (LLM10)

Per-user cost / rate not capped. A malicious actor (or a buggy loop) can drain your budget.

**Detection:** look for LLM SDK calls inside HTTP route handlers without preceding rate limit middleware. Flagged heuristically.

**Fix:** per-tenant LLM token budgets. Hard daily caps. Alerting on cost anomalies.

---

## 12. Stale comments / dead code

Functions that exist but are never called; comments saying "TODO: remove" months old; `if False:` branches; commented-out blocks.

Not a security risk on its own, but a strong signal that the AI generated more than the codebase needs and nobody pruned.

**Detection:**
```bash
rg -n 'if False:|if 0:'
rg -n '^[ \t]*(//|#).*(TODO|FIXME|XXX|HACK)'
```

---

## 13. Confidently-wrong types

`as any`, `# type: ignore`, `@ts-ignore`, `eslint-disable` — used to silence the type-checker rather than fix the underlying issue.

**Detection:**
```bash
rg -n '\bas any\b|@ts-ignore|@ts-expect-error|# type: ignore|eslint-disable'
```

**Fix:** each suppression needs a justification comment with an issue ID.

---

## 14. Hand-rolled crypto

The model decided to implement HMAC / encryption / JWT signing from scratch.

**Detection:**
```bash
rg -n -i '(hmac|sha256|aes|encrypt|decrypt).*for\s+|\bcrypto\.createHash'
```

Flag any file that imports `crypto` AND defines a function named `*sign*` / `*verify*` / `*encrypt*` / `*decrypt*` — review by hand.

**Fix:** use vetted libraries (`jose` for JWT, libsodium for crypto, framework-provided HMAC verify for webhooks).

---

## 15. Race conditions in idempotency

Webhook / payment / job handlers that "check exists then insert" without a unique constraint or transaction.

**Detection:** manual — the `payments` check searches for `event.id`/`idempotency_key` references; if found inside a handler with no `UNIQUE`/`ON CONFLICT`/`INSERT...IGNORE`/transaction wrapping, flag.

**Fix:** persist `event.id` with a `UNIQUE` constraint. Use `INSERT ... ON CONFLICT DO NOTHING`. Wrap in a transaction.
