# Software Template Catalog

catalog_version: 0.1.0-draft
status: taxonomy preserved; executable templates pending

## Detail Levels

| Level | Intended Use | Required Sections | Typical Executor |
| --- | --- | --- | --- |
| `starter` | Small, bounded prototype | Mission, capabilities, constraints, acceptance, exclusions | One coding agent |
| `standard` | Product-quality build | Starter plus users, workflows, data, lifecycle, quality budgets, verification | One agent or small team |
| `factory` | Multi-phase or higher-risk delivery | Standard plus provenance, contracts, DAG, ownership, evidence matrix, scope policy, rollout, rollback | Swarm or Software Factory |

## Categories and Example Products

| Template ID | Category | Example Products | Template Emphasis |
| --- | --- | --- | --- |
| `web-app` | Web applications | Habit tracker; booking system; CRM; portfolio builder | Pages, workflows, responsive states, accessibility, browser tests |
| `saas` | SaaS products | Subscription analytics; inventory management; team workspace; client portal | Tenancy, roles, billing, data isolation, lifecycle states |
| `mobile-app` | Mobile applications | Fitness tracker; expense scanner; field-service app; offline journal | Platform targets, permissions, offline behavior, device testing |
| `desktop-app` | Desktop applications | Markdown editor; media organizer; trading workstation; local research vault | OS support, local storage, filesystem access, packaging |
| `game` | Games | Boat racer; puzzle game; roguelike; multiplayer arena | Game loop, controls, physics, art direction, performance budgets |
| `simulation-3d` | 3D and simulations | Driving simulator; architectural viewer; physics sandbox; digital twin | Coordinate systems, determinism, rendering, simulation parity |
| `api-backend` | APIs and backends | Authentication service; payment API; notification service; content API | Endpoints, schemas, authorization, error contracts, load tests |
| `ai-application` | AI applications | RAG assistant; document classifier; coding copilot; support triage | Model contracts, evaluations, fallbacks, hallucination limits |
| `data-product` | Data products | Analytics dashboard; ETL pipeline; forecasting system; data-quality monitor | Schemas, lineage, validation, freshness, benchmark datasets |
| `automation` | Automation | Email triage; report generator; scheduled sync; compliance reminder | Triggers, actions, retries, idempotency, failure reporting |
| `integration` | Integrations | Stripe billing; Linear sync; CRM connector; calendar bridge | Authentication, rate limits, mappings, reconciliation behavior |
| `developer-tool` | Developer tools | CLI; linter; test runner; code generator | Commands, exit codes, configuration, compatibility, fixtures |
| `infrastructure` | Infrastructure | Deployment pipeline; monitoring service; backup system; internal worker | Environments, rollback, health checks, secrets, recovery tests |
| `existing-system-change` | Existing-system changes | Feature addition; migration; refactor; reliability remediation | Protected behavior, affected surfaces, regression tests, rollout |

## Reference Cases

### Simple - Personal Expense Tracker

- Base template: `web-app@starter`.
- Product: add, edit, categorize, filter, chart, and persist expenses.
- Primary learning: turn a short idea into observable acceptance criteria without unnecessary architecture.
- Expected executor: one coding agent.

### Intermediate - Photography Studio Marketplace

- Base template: `saas@standard` + auth, booking, payments, and media annexes.
- Product: studio discovery, availability, bookings, payments, cancellation, reviews, and owner/customer roles.
- Primary learning: unresolved product policy must be surfaced before implementation.
- Expected executor: one agent with review or a small swarm.

### Complex - Vyon Boat Racer

- Base template: `game@factory` + hardware, simulation-model, and observability annexes. Use `simulation-3d@factory` instead only when physical or spatial fidelity, rather than gameplay, is the dominant product risk.
- Product: stylized 3D racing with water simulation, physics, AI, course state, animation, HUD, audio, and performance gates.
- Primary learning: preserve creative intent while adding deterministic contracts, temporal evidence, bounded critique, and a dependency-aware execution plan.
- Expected executor: reviewed swarm or Software Factory run.

## Template Selection Rules

1. Select the category by the product's dominant risk, not its marketing label.
2. Add annexes only for cross-cutting capabilities that change verification or architecture.
3. Use `starter` when one agent can complete and verify the work in a bounded session.
4. Use `standard` when the product has persistent data, multiple roles, external services, or meaningful lifecycle behavior.
5. Use `factory` when work spans multiple dependencies, shared contracts, agents, repositories, or consequential rollout.
6. Use `existing-system-change` as the base for brownfield work even if the end product belongs to another category.
7. Require specialized annexes and additional review for regulated, financial, medical, security-sensitive, or hardware-dependent systems.

## Maturity States

| State | Meaning |
| --- | --- |
| `draft` | Structure exists; decisions, fixtures, or validation may be incomplete |
| `validated` | Deterministic checks pass and reference fixtures preserve requirements |
| `reviewed` | Consensus or designated human review has accepted the content |
| `published` | Versioned, indexed, documented, and permitted for production project use |
| `deprecated` | Retained for provenance but blocked from new project selection |

## Factory Consumption Contract

Every generated candidate must record:

- Template ID and exact semantic version.
- Template content hash and source-prompt hash.
- Selected detail level and ordered annexes.
- User-resolved decisions and remaining unresolved items.
- Deterministic validation result and optional consensus result.
- Target repository supplied by the operator.
- Explicit statement that generation did not confer `factory-ready` authority.
