# Compliance Starter

Minimums per framework for a typical SaaS launch. Not legal advice — for high-risk situations, retain counsel.

## SOC 2 Type I (starter)

- Encryption at rest + in transit (AES-256, TLS 1.2+)
- MFA enforced on all admin accounts
- Least-privilege IAM with **quarterly access review**
- Centralized audit logging of:
  - Authentication events (success + failure)
  - Permission changes
  - Admin actions
  - Data exports
- Vendor inventory with risk ratings + DPAs
- Change-management with PR review (no direct main push to production code)
- Access provisioning + deprovisioning SOP (within 24h of role change / termination)
- Security policies signed by employees during onboarding
- Annual security-awareness training
- Incident-response plan exists AND has been tested (tabletop OK for Type I)

## GDPR — Article 32 "appropriate technical measures"

- Pseudonymisation / encryption of personal data
- Confidentiality + integrity + availability + resilience of systems
- Ability to restore after incident (tested!)
- Regular testing of effectiveness of measures

Plus (cross-Article):
- **DPA with every sub-processor** handling personal data
- Breach notification ≤ 72h to supervisory authority + affected users (Art. 33/34)
- **DPIA** for high-risk processing (large-scale, sensitive categories, automated decision-making)
- Lawful basis recorded for each processing activity (Art. 6)
- Data export + right-to-erasure endpoints (Art. 17 + 20)
- Privacy policy lists processors + retention windows + lawful basis (Art. 13/14)
- Records of Processing Activities (Art. 30)
- Data Protection Officer if required (public body, large-scale monitoring, large-scale special categories)

## CCPA / CPRA (California)

- Privacy notice at collection (just-in-time, not just in the policy footer)
- Right-to-know endpoint (12-month lookback on disclosures)
- Right-to-delete endpoint
- Right-to-correct endpoint
- Right-to-opt-out-of-sale/share endpoint
- "Do Not Sell or Share My Personal Information" link visible in the footer of every page
- Honor the **Global Privacy Control** browser header
- No discrimination for users exercising rights (no degraded service, no pricing penalty)

## PCI-DSS 4.0 (SAQ A — Stripe Elements / Checkout merchants only)

Mandatory since **2025-04-01**:

- **6.4.3** — Inventory + integrity of all scripts loaded on the payment page (SRI hash or CSP allowlist)
- **11.6.1** — Tamper detection on the payment page (CSP `report-uri` or third-party page-integrity monitor)
- **11.3.2** — External ASV vulnerability scan **quarterly**
- HSTS + TLS 1.2+ on payment pages
- Annual SAQ A self-assessment signed
- No card data stored, processed, or transmitted by your servers (verify via DAST that POST bodies contain no PAN)

## HIPAA (if handling PHI)

- BAAs signed with every vendor that touches PHI
- Audit logs on every PHI access (who, what, when)
- Encryption at rest + in transit (AES-256, TLS 1.2+)
- Access controls (unique IDs, RBAC, auto-logoff)
- Backup + disaster recovery plan
- Workforce training, sanction policy, ongoing risk analysis

## Stripe-specific (if processing payments)

- Idempotency on every charge / refund (use `Idempotency-Key`)
- Webhook signature verification (see `references/tool-reference.md` § Stripe)
- Separate `whsec_*` per environment
- Allowlist Stripe IPs at edge if WAF available
- Radar rules tuned for your fraud risk
- Tax / VAT calculation if international
- Strong Customer Authentication (SCA) for EU customers (3DS2 via Stripe)
- Refund + dispute process documented
