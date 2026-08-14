# OWASP Quick Reference

## Web Top 10 (2021 — current)

| ID | Category | Common manifestation |
|----|----------|----------------------|
| A01 | Broken Access Control | BOLA / IDOR — user A reads user B's resource via direct URL |
| A02 | Cryptographic Failures | Plaintext passwords, MD5/SHA1, missing TLS, secrets in code |
| A03 | Injection | SQLi, XSS, command injection — unvalidated input reaches a sensitive sink |
| A04 | Insecure Design | Missing rate limits, missing authentication, business-logic flaws |
| A05 | Security Misconfiguration | Default creds, verbose errors, unused features enabled, missing headers |
| A06 | Vulnerable & Outdated Components | Lockfile with known CVEs, abandoned libs, typosquatted packages |
| A07 | Identification & Auth Failures | Weak passwords, no MFA, broken session, no lockout |
| A08 | Software & Data Integrity Failures | Unsigned releases, unverified updates, compromised CI |
| A09 | Security Logging & Monitoring Failures | No alerting, no audit trail, PII in logs |
| A10 | Server-Side Request Forgery | `fetch(userInput)` against internal metadata services |

## API Top 10 (2023)

| ID | Category |
|----|----------|
| API1 | **Broken Object Level Authorization (BOLA)** — accounts for ~40% of API attacks |
| API2 | Broken Authentication |
| API3 | Broken Object Property Level Authorization |
| API4 | Unrestricted Resource Consumption |
| API5 | Broken Function Level Authorization |
| API6 | Unrestricted Access to Sensitive Business Flows |
| API7 | Server-Side Request Forgery |
| API8 | Security Misconfiguration |
| API9 | Improper Inventory Management |
| API10 | Unsafe Consumption of APIs |

## LLM Top 10 (2025)

| ID | Category |
|----|----------|
| LLM01 | Prompt Injection (direct + indirect) |
| LLM02 | Sensitive Information Disclosure |
| LLM03 | Supply Chain |
| LLM04 | Data and Model Poisoning |
| LLM05 | Improper Output Handling |
| LLM06 | Excessive Agency |
| LLM07 | System Prompt Leakage |
| LLM08 | Vector and Embedding Weaknesses |
| LLM09 | Misinformation |
| LLM10 | Unbounded Consumption |

## Minimum tooling for OWASP coverage

No single tool covers everything. Defensible minimum:

- **SAST**: semgrep (`p/owasp-top-ten`, `p/sql-injection`, `p/xss`, `p/jwt`)
- **SCA**: osv-scanner OR trivy
- **DAST**: ZAP baseline + nuclei templates (for deployed URL)
- **Secrets**: gitleaks (CI) + trufflehog (`--only-verified`)
- **Headers**: securityheaders.com / observatory

Run them on every release branch. Block merge on critical/high findings.

## References

- Web Top 10: https://owasp.org/Top10/
- API Top 10: https://owasp.org/API-Security/editions/2023/
- LLM Top 10: https://genai.owasp.org/llm-top-10/
- Cheat Sheets: https://cheatsheetseries.owasp.org/
