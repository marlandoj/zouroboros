# Factory Software Template Library Package Post-Flight

Date: 2026-08-18
Linear: ZOU-1432
Seed: `seed-factory-template-library-2026-08-18`
Status: PASS

## Executive Result

`zouroboros-factory` now carries and installs the published Software Template
Library as a second governed runtime component. The distribution preserves the
catalog `1.0.0` and tooling `1.0.1` payload, verifies four immutable hashes,
copies a contained Ajv `8.17.1` runtime closure, and retains fail-closed factory
defaults and human merge authority.

The final tarball contains 404 entries, is 1,055,705 bytes, and has SHA-256
`85256fe9b2139ecf2337b704fc63066f73a56de2235810451c04720790ee38ee`.

## Mechanical Verification

| Check | Result |
| --- | --- |
| Constitution document gate | PASS |
| Canonical library data/schema/template byte comparison | PASS |
| Factory strict TypeScript | PASS |
| Repository build | PASS |
| Repository-wide TypeScript after build | PASS |
| Factory and runtime-materialization tests | PASS, 11/11 |
| Package boundary checks | PASS, 53/53 |
| Catalog validation | PASS, 14 categories, 42 variants, 12 annexes |
| Exact `web-app@1.0.0` resolution | PASS |
| Factory MVP smoke | PASS, 10/10 |
| Coding cascade regression | PASS, 45/45 |
| Extracted-tarball integration test | PASS, 1/1 |
| Complete repository test suite | PASS |
| Staged whitespace check | PASS; canonical generated hard breaks are covered by scoped attributes |

The initial repository-wide typecheck failed because the fresh clone had not
built `zouroboros-core` declarations. `pnpm build` completed successfully, and
the required second `pnpm typecheck` pass was clean across the workspace.

## Acceptance Criteria

| # | Criterion | Evidence | Result |
| --- | --- | --- | --- |
| 1 | Tarball carries the operational library | 96 payload files; archive entries verified | PASS |
| 2 | Ajv 8.17.1 is declared | Factory and distribution manifests | PASS |
| 3 | Installer materializes the library beside the factory | Source and extracted-tarball install tests | PASS |
| 4 | Install reports exact paths and versions | `InstallResult` and `.factory-package.json` assertions | PASS |
| 5 | Doctor rejects missing files, dependencies, and hash drift | Boundary checks plus runtime validation | PASS |
| 6 | Package check rejects unsafe content and drift | 53/53 boundary checks; tamper test | PASS |
| 7 | Forced upgrades preserve operator runtime flags | Focused upgrade test | PASS |
| 8 | Installed library validates and resolves an exact template | Source smoke and archive test | PASS |
| 9 | Factory and cascade regressions remain green | MVP 10/10; cascade 45/45 | PASS |
| 10 | Extracted tarball works without omitted source payload | Archive integration test | PASS |
| 11 | Post-flight and five-part audit are durable | This report | PASS |

## Gap Audit

### Reachability: PASS

The `install` CLI invokes `installFactory`, which materializes both
`Projects/zouroboros-software-factory` and `Projects/software-template-library`.
`doctor` validates the installed library, `smoke` validates and resolves a
template before the factory lifecycle, and runtime materialization recognizes
both installed and package-source library layouts.

### Data Prerequisites: PASS

The package includes the catalog, discovery index, persona-association data,
both schemas, compiler and resolver, and every generated template. All four
published hashes match the canonical source. The installer copies Ajv and its
four runtime dependencies into the installed library's contained
`node_modules` directory.

### Cross-Boundary State: PASS

The extracted-tarball test stages dependencies independently, invokes the CLI
from the archive, installs into a separate target checkout, runs doctor, and
runs smoke. Forced upgrades preserve `config/runtime-flags.json`; installation
still creates no scheduler and grants no execution authority.

### Eval-Production Parity: PASS

The source smoke and archive test call the same packaged CLI, installer,
doctor, library compiler, and factory MVP entrypoint used by operators. The
archive test does not substitute a benchmark-only library implementation.

### Dangling Identifiers: PASS

Active source references now recognize both
`Projects/software-template-library` and
`packages/factory/software-template-library`. No resource was deleted or
renamed. Retained evaluations, project plans, Linear mutation scripts, and
model-review scripts are absent from the distribution and package boundary.

## Activation Boundary

The package does not configure a conveyor trigger, enable runtime lanes, create
credentials, invoke model review, or merge code. The target remains a
Zouroboros checkout and must provide the canonical
`Skills/compile-build-spec/scripts/spec-tool.ts` validator. `doctor` fails
closed if that dependency is unavailable.
