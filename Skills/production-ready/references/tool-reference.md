# Tool Reference

Every tool the `production-ready` skill can invoke, with install + one-shot CLI examples.
All offline-capable scanners run without network after initial DB downloads.

## OWASP coverage matrix

| ID | Category | Primary detection method |
|----|----------|--------------------------|
| A01 | Broken Access Control | DAST + manual (BOLA tests, IDOR fuzzing) |
| A02 | Cryptographic Failures | SAST (semgrep), config review |
| A03 | Injection (SQLi/XSS/cmdi) | SAST + DAST (ZAP, nuclei) |
| A04 | Insecure Design | Threat modeling, manual |
| A05 | Security Misconfiguration | DAST + IaC scan (`trivy config`) |
| A06 | Vulnerable Components | SCA (osv-scanner, trivy, npm audit) |
| A07 | ID & Auth Failures | DAST + manual (session, MFA, lockout) |
| A08 | Software/Data Integrity | SCA + supply-chain (sigstore, lockfile review) |
| A09 | Logging/Monitoring Failures | Runtime/SIEM review, manual |
| A10 | SSRF | SAST + DAST (nuclei ssrf templates) |

**OWASP API Top 10 (2023)** — API1 BOLA (40% of API attacks), API2 Broken Auth, API3 Broken Object Property Auth, API4 Unrestricted Resource Consumption, API5 Broken Function Level Auth, API6 Unrestricted Sensitive Business Flow, API7 SSRF, API8 Misconfig, API9 Improper Inventory, API10 Unsafe API Consumption.

**OWASP LLM Top 10 (2025)** — LLM01 Prompt Injection (direct + indirect), LLM02 Sensitive Info Disclosure, LLM03 Supply Chain, LLM04 Data/Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, LLM07 System Prompt Leakage, LLM08 Vector/Embedding Weaknesses, LLM09 Misinformation, LLM10 Unbounded Consumption.

No single tool covers all of OWASP Top 10. Minimum stack = SAST + SCA + DAST + secrets + headers.

---

## Secrets scanning

### gitleaks (recommended for pre-commit + CI diff)
```bash
brew install gitleaks  # or docker pull zricethezav/gitleaks:latest
gitleaks detect --source . --report-format json --report-path leaks.json --redact
gitleaks detect --log-opts="--all" --source .                          # full history
```
Offline. Output: JSON / SARIF / CSV.

### trufflehog (live verification, low FP)
```bash
brew install trufflehog
trufflehog filesystem . --json --only-verified > trufflehog.json
trufflehog git file://. --since-commit HEAD~50 --only-verified
```
Network required for `--only-verified` (calls vendor APIs to confirm live creds).

### detect-secrets (baseline for legacy repos)
```bash
pip install detect-secrets
detect-secrets scan > .secrets.baseline
detect-secrets audit .secrets.baseline
```

CI pattern: **gitleaks pre-commit + trufflehog `--only-verified` in CI**.

---

## SAST

### semgrep (polyglot, free OSS rules)
```bash
pip install semgrep  # or brew install semgrep
semgrep --config p/default --config p/owasp-top-ten --config p/secrets --json -o semgrep.json .
semgrep --config ./rules/ --json .  # fully offline with bundled rules
```
`--config auto` and `p/*` configs pull from registry; bundled local rules work offline.

### bandit (Python)
```bash
pip install bandit
bandit -r . -f json -o bandit.json -ll  # -ll = medium+ severity
bandit -r . -f sarif -o bandit.sarif
```

### eslint-plugin-security (JS/TS)
```bash
npm i -D eslint @eslint-community/eslint-plugin-security
npx eslint --ext .js,.ts -f json -o eslint.json .
```

---

## Dependency / SCA

### osv-scanner (lowest false positives — ecosystem-native)
```bash
brew install osv-scanner  # or go install github.com/google/osv-scanner/cmd/osv-scanner@latest
osv-scanner scan source -r . --format json --output osv.json
osv-scanner scan source -S sbom.cdx.json  # output SBOM
```
Queries osv.dev; offline via `--offline-vulnerabilities --download-offline-databases`.

### trivy (containers, repos, IaC, SBOMs in one binary)
```bash
brew install trivy
trivy fs --format json --output trivy.json --severity HIGH,CRITICAL .
trivy image --format json --output trivy-img.json node:20
trivy config --format json .                          # IaC / Terraform / K8s
trivy image --format cyclonedx -o sbom.json node:20   # SBOM
```
DB downloaded once; subsequent scans offline with `--skip-update`.

### grype (containers + SBOMs)
```bash
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin
grype dir:. -o json > grype.json
# Offline after initial DB:
GRYPE_DB_AUTO_UPDATE=false grype dir:.
```

### npm audit / pip-audit
```bash
npm audit --json --audit-level=high > npm-audit.json
npm audit fix                               # or --force for breaking
pip install pip-audit
pip-audit -r requirements.txt -f json -o pip-audit.json
```

### License scanning
```bash
npm i -g license-checker
license-checker --json --production --excludePrivatePackages > licenses.json
license-checker --failOn 'GPL;AGPL;LGPL;CC-BY-NC'
```

### IaC / config
```bash
trivy config --severity HIGH,CRITICAL .
pip install checkov && checkov -d . -o json
```

---

## DAST (against deployed URL)

### OWASP ZAP
```bash
# Baseline (fast, passive)
docker run -v $(pwd):/zap/wrk -t zaproxy/zap-stable \
  zap-baseline.py -t https://target.example.com -J zap.json -r zap.html

# Full active scan
docker run -v $(pwd):/zap/wrk -t zaproxy/zap-stable \
  zap-full-scan.py -t https://target.example.com -J zap.json

# Automation framework
docker run -v $(pwd):/zap/wrk:rw -t zaproxy/zap-stable zap.sh -cmd -autorun /zap/wrk/zap.yaml
```

### nuclei (template-driven CVE + misconfig)
```bash
brew install nuclei  # or go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
nuclei -update-templates
nuclei -u https://target.example.com -severity critical,high -jsonl -o nuclei.json
nuclei -u https://target -tags ssrf,xss,sqli,cve
```

### nikto (legacy server config)
```bash
apt install nikto  # or brew install nikto
nikto -h https://target.example.com -Format json -output nikto.json
```

### wapiti (Python fuzzer — XSS, SQLi, XXE)
```bash
pip install wapiti3
wapiti -u https://target.example.com -f json -o wapiti.json --flush-session
# For JS-heavy SPAs:
wapiti -u https://target --headless visible
```

---

## Accessibility (WCAG 2.2)

### axe-core CLI (uses WCAG 2.2 rules since 4.5)
```bash
npm i -g @axe-core/cli
axe https://target.example.com --save axe.json --tags wcag2aa,wcag22aa
```

### pa11y / pa11y-ci
```bash
npm i -g pa11y pa11y-ci
pa11y https://target.example.com --reporter json --standard WCAG2AA > pa11y.json
pa11y-ci --sitemap https://target/sitemap.xml --json
```

### lighthouse (uses axe-core for a11y)
```bash
npm i -g lighthouse
lighthouse https://target.example.com \
  --output=json --output-path=lh.json \
  --only-categories=accessibility,performance,best-practices,seo \
  --chrome-flags="--headless"
```

> Automated tools catch ~30–40% of WCAG issues. Keyboard + screen-reader manual pass is still required.

---

## Performance — Core Web Vitals

**Google "Good" thresholds at p75:**
- LCP ≤ 2.5s
- INP ≤ 200ms (replaced FID March 2024; Lighthouse uses TBT as proxy)
- CLS ≤ 0.1
- TTFB ≤ 0.8s
- FCP ≤ 1.8s

### lighthouse-ci
```bash
npm i -g @lhci/cli
lhci autorun --collect.url=https://target --upload.target=temporary-public-storage
```

**`lighthouserc.json` budget:**
```json
{ "ci": { "assert": { "assertions": {
  "categories:performance": ["error", { "minScore": 0.9 }],
  "categories:accessibility": ["error", { "minScore": 0.95 }],
  "largest-contentful-paint": ["error", { "maxNumericValue": 2500 }],
  "cumulative-layout-shift": ["error", { "maxNumericValue": 0.1 }],
  "total-blocking-time": ["error", { "maxNumericValue": 200 }]
}}}}
```

---

## Security headers + CSP

**Minimum production header set:**
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: <see below>
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(self)
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store    # on authenticated responses
```

**Strict CSP starter (no `unsafe-inline`/`unsafe-eval`):**
```
Content-Security-Policy:
  default-src 'none';
  script-src 'nonce-{RANDOM}' 'strict-dynamic';
  style-src 'self' 'nonce-{RANDOM}';
  img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self' https://api.stripe.com;
  frame-src https://js.stripe.com https://hooks.stripe.com;
  base-uri 'none';
  form-action 'self';
  frame-ancestors 'none';
  object-src 'none';
  upgrade-insecure-requests;
  report-uri /csp-report
```

**Evaluators:**
```bash
curl -sI https://target | grep -i 'strict-transport\|content-security\|x-frame\|referrer\|permissions'
npm i -g observatory-cli && observatory target.example.com --format=json
# Google CSP Evaluator (UI only): csp-evaluator.withgoogle.com
```

---

## Suggested audit run order (one shell pass)

```bash
# 1. Secrets
gitleaks detect --source . --report-format sarif -r gitleaks.sarif
trufflehog filesystem . --json --only-verified > trufflehog.json

# 2. SAST
semgrep --config p/owasp-top-ten --config p/secrets --config p/jwt --severity ERROR --sarif -o semgrep.sarif .
bandit -r . -f sarif -o bandit.sarif -ll 2>/dev/null || true
npx eslint --ext .js,.ts,.tsx -f json -o eslint.json . || true

# 3. Deps
osv-scanner scan source -r . --format json --output osv.json
trivy fs --severity HIGH,CRITICAL --format json -o trivy.json .
npm audit --json --audit-level=high > npm-audit.json || true

# 4. Licenses
license-checker --json --production --excludePrivatePackages > licenses.json || true

# 5. AI-failure greps  (see ai-failure-modes.md)

# 6. Against deployed URL
docker run --rm -v $(pwd):/zap/wrk -t zaproxy/zap-stable zap-baseline.py -t $URL -J zap.json
nuclei -u $URL -severity critical,high,medium -jsonl -o nuclei.json
npx @axe-core/cli $URL --save axe.json --tags wcag2aa,wcag22aa
npx pa11y $URL --reporter json --standard WCAG2AA > pa11y.json
lighthouse $URL --output=json --output-path=lh.json --chrome-flags="--headless"
curl -sI $URL | tee headers.txt
```
