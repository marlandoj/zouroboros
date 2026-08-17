import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameGauntletTerminalState } from "./game-gauntlet-contract";

export const GAME_MANIFEST_CONTRACT_VERSION = 1 as const;

export const GOVERNED_MANIFEST_DOMAINS = [
  "candidate-source",
  "candidate-assets",
  "reference-corpus",
  "harness",
  "production-controls",
  "rubrics",
  "scenarios",
  "evidence",
] as const;
export type GovernedManifestDomain = (typeof GOVERNED_MANIFEST_DOMAINS)[number];

export const EVIDENCE_MANIFEST_DOMAIN = "evidence" as const satisfies GovernedManifestDomain;

export const CANDIDATE_MANIFEST_DOMAINS = GOVERNED_MANIFEST_DOMAINS.filter(
  (domain) => domain !== EVIDENCE_MANIFEST_DOMAIN,
) as readonly GovernedManifestDomain[];

export const CAPTURE_PHASES = ["pre-capture", "post-capture"] as const;
export type CapturePhase = (typeof CAPTURE_PHASES)[number];

export const CRITIC_LEASE_ACCESS_MODE = "read-only" as const;

export const GAME_MANIFEST_VIOLATION_CODES = [
  "unknown-version",
  "unknown-domain",
  "missing-domain",
  "malformed-entry",
  "duplicate-path",
  "empty-manifest",
  "digest-mismatch",
  "candidate-digest-mismatch",
  "bundle-digest-mismatch",
  "capture-phase-mismatch",
  "candidate-identity-mismatch",
  "governed-mutation",
  "evidence-mutation",
  "lease-candidate-mismatch",
  "lease-digest-mismatch",
  "lease-expired",
  "lease-revoked",
  "lease-write-access",
  "lease-unknown-version",
  "missing-incumbent",
  "missing-rollback-reference",
] as const;
export type GameManifestViolationCode = (typeof GAME_MANIFEST_VIOLATION_CODES)[number];

export interface GameManifestViolation {
  code: GameManifestViolationCode;
  subject: string;
  detail: string;
}

export class GameManifestContractViolation extends Error {
  readonly violations: readonly GameManifestViolation[];

  constructor(violations: readonly GameManifestViolation[]) {
    const summary = violations.map((violation) => `${violation.code}@${violation.subject}`).join(", ");
    super(`game manifest contract failed closed: ${summary}`);
    this.name = "GameManifestContractViolation";
    this.violations = violations;
  }
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface FrozenManifest {
  contractVersion: typeof GAME_MANIFEST_CONTRACT_VERSION;
  domain: GovernedManifestDomain;
  algorithm: "sha256";
  entries: readonly ManifestEntry[];
  digest: string;
}

export type FrozenManifestSet = Readonly<Record<GovernedManifestDomain, FrozenManifest>>;

export interface FrozenCandidateBundle {
  contractVersion: typeof GAME_MANIFEST_CONTRACT_VERSION;
  candidateId: string;
  capturePhase: CapturePhase;
  manifests: FrozenManifestSet;
  candidateDigest: string;
  bundleDigest: string;
}

export interface CriticLease {
  contractVersion: typeof GAME_MANIFEST_CONTRACT_VERSION;
  leaseId: string;
  candidateId: string;
  candidateDigest: string;
  criticId: string;
  lens: string;
  accessMode: typeof CRITIC_LEASE_ACCESS_MODE;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedReason: string | null;
}

export type GovernedMutationKind = "added" | "removed" | "modified";

export interface GovernedMutation {
  domain: GovernedManifestDomain;
  path: string;
  kind: GovernedMutationKind;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ManifestIntegrityReport {
  valid: boolean;
  violations: readonly GameManifestViolation[];
  mutations: readonly GovernedMutation[];
  blockedReasons: readonly string[];
}

export interface CriticRoundInput {
  before: FrozenCandidateBundle;
  after: FrozenCandidateBundle;
  lease: CriticLease;
  now: string;
  incumbentHash: string;
  rollbackReference: string;
  /** Evidence is produced by capture, so it is sealed at post-capture instead of carried forward. */
  sealedEvidenceDigest?: string | null;
}

export interface CriticRoundDecision {
  allowed: boolean;
  terminalState: GameGauntletTerminalState | null;
  scoresSuppressed: boolean;
  promotionBlocked: boolean;
  incumbentHash: string;
  rollbackReference: string;
  report: ManifestIntegrityReport;
}

const DOMAIN_SET: ReadonlySet<string> = new Set(GOVERNED_MANIFEST_DOMAINS);
const CAPTURE_PHASE_SET: ReadonlySet<string> = new Set(CAPTURE_PHASES);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function manifestEntryFromContent(path: string, content: string | Uint8Array): ManifestEntry {
  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
  return { path, sha256: sha256Hex(content), bytes };
}

export function manifestEntriesFromFiles(root: string, relativePaths: readonly string[]): ManifestEntry[] {
  return relativePaths.map((relativePath) => {
    const data = readFileSync(join(root, relativePath));
    return { path: relativePath, sha256: sha256Hex(data), bytes: data.byteLength };
  });
}

function sortEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function computeManifestDigest(domain: GovernedManifestDomain, entries: readonly ManifestEntry[]): string {
  const hash = createHash("sha256");
  hash.update(`v${GAME_MANIFEST_CONTRACT_VERSION}\n${domain}\n`);
  for (const entry of sortEntries(entries)) {
    hash.update(`${entry.path}\u0000${entry.sha256}\u0000${entry.bytes}\n`);
  }
  return hash.digest("hex");
}

function computeSetDigest(label: string, manifests: FrozenManifestSet, domains: readonly GovernedManifestDomain[]): string {
  const hash = createHash("sha256");
  hash.update(`v${GAME_MANIFEST_CONTRACT_VERSION}\n${label}\n`);
  for (const domain of domains) {
    hash.update(`${domain}\u0000${manifests[domain]?.digest ?? ""}\n`);
  }
  return hash.digest("hex");
}

export function computeCandidateDigest(manifests: FrozenManifestSet): string {
  return computeSetDigest("candidate", manifests, CANDIDATE_MANIFEST_DOMAINS);
}

export function computeBundleDigest(manifests: FrozenManifestSet): string {
  return computeSetDigest("bundle", manifests, GOVERNED_MANIFEST_DOMAINS);
}

export function freezeManifest(domain: GovernedManifestDomain, entries: readonly ManifestEntry[]): FrozenManifest {
  if (!DOMAIN_SET.has(domain)) {
    throw new GameManifestContractViolation([
      { code: "unknown-domain", subject: String(domain), detail: "domain is not governed by this contract" },
    ]);
  }
  const sorted = sortEntries(entries);
  const violations: GameManifestViolation[] = [];
  validateEntries(domain, sorted, violations);
  if (violations.length > 0) throw new GameManifestContractViolation(violations);

  return Object.freeze({
    contractVersion: GAME_MANIFEST_CONTRACT_VERSION,
    domain,
    algorithm: "sha256",
    entries: Object.freeze(sorted.map((entry) => Object.freeze({ ...entry }))),
    digest: computeManifestDigest(domain, sorted),
  }) satisfies FrozenManifest;
}

export function freezeCandidateBundle(
  candidateId: string,
  capturePhase: CapturePhase,
  manifests: Partial<Record<GovernedManifestDomain, FrozenManifest>>,
): FrozenCandidateBundle {
  const violations: GameManifestViolation[] = [];
  if (!candidateId.trim()) {
    violations.push({ code: "candidate-identity-mismatch", subject: "candidateId", detail: "candidateId is required" });
  }
  if (!CAPTURE_PHASE_SET.has(capturePhase)) {
    violations.push({ code: "capture-phase-mismatch", subject: String(capturePhase), detail: "unknown capture phase" });
  }
  for (const domain of GOVERNED_MANIFEST_DOMAINS) {
    if (!manifests[domain]) {
      violations.push({ code: "missing-domain", subject: domain, detail: "every governed domain must be hashed" });
    }
  }
  if (violations.length > 0) throw new GameManifestContractViolation(violations);

  const complete = Object.freeze({ ...manifests } as Record<GovernedManifestDomain, FrozenManifest>);
  return Object.freeze({
    contractVersion: GAME_MANIFEST_CONTRACT_VERSION,
    candidateId,
    capturePhase,
    manifests: complete,
    candidateDigest: computeCandidateDigest(complete),
    bundleDigest: computeBundleDigest(complete),
  }) satisfies FrozenCandidateBundle;
}

export interface CriticLeaseRequest {
  leaseId: string;
  criticId: string;
  lens: string;
  issuedAt: string;
  ttlSeconds: number;
}

export function issueCriticLease(bundle: FrozenCandidateBundle, request: CriticLeaseRequest): CriticLease {
  const violations: GameManifestViolation[] = [];
  if (bundle.capturePhase !== "pre-capture") {
    violations.push({
      code: "capture-phase-mismatch",
      subject: bundle.capturePhase,
      detail: "a critic lease may only be issued against the pre-capture frozen bundle",
    });
  }
  if (!Number.isFinite(request.ttlSeconds) || request.ttlSeconds <= 0) {
    violations.push({ code: "lease-expired", subject: String(request.ttlSeconds), detail: "ttlSeconds must be positive" });
  }
  const issuedAtMs = Date.parse(request.issuedAt);
  if (Number.isNaN(issuedAtMs)) {
    violations.push({ code: "lease-expired", subject: request.issuedAt, detail: "issuedAt must be an ISO timestamp" });
  }
  if (violations.length > 0) throw new GameManifestContractViolation(violations);

  return Object.freeze({
    contractVersion: GAME_MANIFEST_CONTRACT_VERSION,
    leaseId: request.leaseId,
    candidateId: bundle.candidateId,
    candidateDigest: bundle.candidateDigest,
    criticId: request.criticId,
    lens: request.lens,
    accessMode: CRITIC_LEASE_ACCESS_MODE,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + request.ttlSeconds * 1000).toISOString(),
    revoked: false,
    revokedReason: null,
  }) satisfies CriticLease;
}

export function revokeCriticLease(lease: CriticLease, reason: string): CriticLease {
  return Object.freeze({ ...lease, revoked: true, revokedReason: reason }) satisfies CriticLease;
}

function validateEntries(
  domain: GovernedManifestDomain,
  entries: readonly ManifestEntry[],
  violations: GameManifestViolation[],
): void {
  if (entries.length === 0 && domain !== EVIDENCE_MANIFEST_DOMAIN) {
    violations.push({ code: "empty-manifest", subject: domain, detail: "a governed manifest may not be empty" });
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || !entry.path.trim()) {
      violations.push({ code: "malformed-entry", subject: domain, detail: "entry.path must be a non-empty string" });
      continue;
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      violations.push({ code: "malformed-entry", subject: `${domain}:${entry.path}`, detail: "entry.sha256 must be a sha256 hex digest" });
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      violations.push({ code: "malformed-entry", subject: `${domain}:${entry.path}`, detail: "entry.bytes must be a non-negative integer" });
    }
    if (seen.has(entry.path)) {
      violations.push({ code: "duplicate-path", subject: `${domain}:${entry.path}`, detail: "a path may appear once per manifest" });
    }
    seen.add(entry.path);
  }
}

function validateBundle(
  bundle: FrozenCandidateBundle,
  label: string,
  expectedPhase: CapturePhase,
  violations: GameManifestViolation[],
): boolean {
  if (bundle?.contractVersion !== GAME_MANIFEST_CONTRACT_VERSION) {
    violations.push({
      code: "unknown-version",
      subject: `${label}:${String(bundle?.contractVersion)}`,
      detail: `expected manifest contract version ${GAME_MANIFEST_CONTRACT_VERSION}`,
    });
    return false;
  }
  if (bundle.capturePhase !== expectedPhase) {
    violations.push({
      code: "capture-phase-mismatch",
      subject: `${label}:${String(bundle.capturePhase)}`,
      detail: `expected the ${expectedPhase} bundle`,
    });
  }
  if (typeof bundle.candidateId !== "string" || !bundle.candidateId.trim()) {
    violations.push({ code: "candidate-identity-mismatch", subject: label, detail: "candidateId is required" });
  }

  let structural = true;
  for (const domain of GOVERNED_MANIFEST_DOMAINS) {
    const manifest = bundle.manifests?.[domain];
    if (!manifest) {
      violations.push({ code: "missing-domain", subject: `${label}:${domain}`, detail: "every governed domain must be hashed" });
      structural = false;
      continue;
    }
    if (manifest.domain !== domain) {
      violations.push({ code: "unknown-domain", subject: `${label}:${String(manifest.domain)}`, detail: `manifest filed under ${domain}` });
      structural = false;
      continue;
    }
    const entries = Array.isArray(manifest.entries) ? manifest.entries : null;
    if (!entries) {
      violations.push({ code: "malformed-entry", subject: `${label}:${domain}`, detail: "entries must be an array" });
      structural = false;
      continue;
    }
    const before = violations.length;
    validateEntries(domain, entries, violations);
    if (violations.length > before) structural = false;
    const recomputed = computeManifestDigest(domain, entries);
    if (manifest.digest !== recomputed) {
      violations.push({
        code: "digest-mismatch",
        subject: `${label}:${domain}`,
        detail: `recorded ${String(manifest.digest)} does not match recomputed ${recomputed}`,
      });
      structural = false;
    }
  }

  if (!structural) return false;

  const candidateDigest = computeCandidateDigest(bundle.manifests);
  if (bundle.candidateDigest !== candidateDigest) {
    violations.push({
      code: "candidate-digest-mismatch",
      subject: label,
      detail: `recorded ${String(bundle.candidateDigest)} does not match recomputed ${candidateDigest}`,
    });
    structural = false;
  }
  const bundleDigest = computeBundleDigest(bundle.manifests);
  if (bundle.bundleDigest !== bundleDigest) {
    violations.push({
      code: "bundle-digest-mismatch",
      subject: label,
      detail: `recorded ${String(bundle.bundleDigest)} does not match recomputed ${bundleDigest}`,
    });
    structural = false;
  }
  return structural;
}

export function diffManifest(before: FrozenManifest, after: FrozenManifest): readonly GovernedMutation[] {
  const domain = before.domain;
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry] as const));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry] as const));
  const mutations: GovernedMutation[] = [];

  for (const [path, beforeEntry] of beforeByPath) {
    const afterEntry = afterByPath.get(path);
    if (!afterEntry) {
      mutations.push({ domain, path, kind: "removed", beforeSha256: beforeEntry.sha256, afterSha256: null });
      continue;
    }
    if (afterEntry.sha256 !== beforeEntry.sha256 || afterEntry.bytes !== beforeEntry.bytes) {
      mutations.push({ domain, path, kind: "modified", beforeSha256: beforeEntry.sha256, afterSha256: afterEntry.sha256 });
    }
  }
  for (const [path, afterEntry] of afterByPath) {
    if (!beforeByPath.has(path)) {
      mutations.push({ domain, path, kind: "added", beforeSha256: null, afterSha256: afterEntry.sha256 });
    }
  }
  return mutations;
}

export function collectGovernedMutations(
  before: FrozenCandidateBundle,
  after: FrozenCandidateBundle,
): readonly GovernedMutation[] {
  const mutations: GovernedMutation[] = [];
  for (const domain of GOVERNED_MANIFEST_DOMAINS) {
    const beforeManifest = before.manifests?.[domain];
    const afterManifest = after.manifests?.[domain];
    if (!beforeManifest || !afterManifest) continue;
    const domainMutations = diffManifest(beforeManifest, afterManifest);
    if (domain === EVIDENCE_MANIFEST_DOMAIN) {
      mutations.push(...domainMutations.filter((mutation) => mutation.kind !== "added"));
      continue;
    }
    mutations.push(...domainMutations);
  }
  return mutations;
}

function validateLease(
  lease: CriticLease,
  before: FrozenCandidateBundle,
  after: FrozenCandidateBundle,
  now: string,
  violations: GameManifestViolation[],
): void {
  if (lease?.contractVersion !== GAME_MANIFEST_CONTRACT_VERSION) {
    violations.push({
      code: "lease-unknown-version",
      subject: String(lease?.contractVersion),
      detail: `expected manifest contract version ${GAME_MANIFEST_CONTRACT_VERSION}`,
    });
    return;
  }
  if (lease.accessMode !== CRITIC_LEASE_ACCESS_MODE) {
    violations.push({
      code: "lease-write-access",
      subject: lease.leaseId,
      detail: `critic leases must be ${CRITIC_LEASE_ACCESS_MODE}, received ${String(lease.accessMode)}`,
    });
  }
  if (lease.revoked) {
    violations.push({ code: "lease-revoked", subject: lease.leaseId, detail: lease.revokedReason ?? "lease revoked" });
  }
  if (lease.candidateId !== before.candidateId || lease.candidateId !== after.candidateId) {
    violations.push({
      code: "lease-candidate-mismatch",
      subject: lease.leaseId,
      detail: `lease candidate ${String(lease.candidateId)} does not match the leased bundle`,
    });
  }
  if (lease.candidateDigest !== before.candidateDigest) {
    violations.push({
      code: "lease-digest-mismatch",
      subject: lease.leaseId,
      detail: "lease was not issued against the pre-capture content address",
    });
  }
  if (lease.candidateDigest !== after.candidateDigest) {
    violations.push({
      code: "lease-digest-mismatch",
      subject: lease.leaseId,
      detail: "the leased content address changed while the critic held the lease",
    });
  }
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(lease.expiresAt);
  if (Number.isNaN(nowMs) || Number.isNaN(expiresMs)) {
    violations.push({ code: "lease-expired", subject: lease.leaseId, detail: "lease timestamps must be ISO timestamps" });
    return;
  }
  if (nowMs > expiresMs) {
    violations.push({ code: "lease-expired", subject: lease.leaseId, detail: `expired at ${lease.expiresAt}, evaluated at ${now}` });
  }
}

function formatBlockedReason(violation: GameManifestViolation): string {
  return `${violation.code}: ${violation.subject} - ${violation.detail}`;
}

export function evaluateManifestIntegrity(input: CriticRoundInput): ManifestIntegrityReport {
  const violations: GameManifestViolation[] = [];

  if (!input.incumbentHash?.trim()) {
    violations.push({ code: "missing-incumbent", subject: "incumbentHash", detail: "the best verified incumbent must be retained" });
  }
  if (!input.rollbackReference?.trim()) {
    violations.push({ code: "missing-rollback-reference", subject: "rollbackReference", detail: "an exact rollback reference is required" });
  }

  const beforeValid = validateBundle(input.before, "pre-capture", "pre-capture", violations);
  const afterValid = validateBundle(input.after, "post-capture", "post-capture", violations);

  let mutations: readonly GovernedMutation[] = [];
  if (beforeValid && afterValid) {
    if (input.before.candidateId !== input.after.candidateId) {
      violations.push({
        code: "candidate-identity-mismatch",
        subject: `${input.before.candidateId}!=${input.after.candidateId}`,
        detail: "pre- and post-capture bundles must describe the same candidate",
      });
    }
    const sealedEvidenceDigest = input.sealedEvidenceDigest?.trim();
    if (sealedEvidenceDigest) {
      const captured = input.after.manifests[EVIDENCE_MANIFEST_DOMAIN].digest;
      if (captured !== sealedEvidenceDigest) {
        violations.push({
          code: "evidence-mutation",
          subject: EVIDENCE_MANIFEST_DOMAIN,
          detail: `sealed ${sealedEvidenceDigest} does not match post-capture ${captured}`,
        });
      }
    }
    mutations = collectGovernedMutations(input.before, input.after);
    for (const mutation of mutations) {
      violations.push({
        code: mutation.domain === EVIDENCE_MANIFEST_DOMAIN ? "evidence-mutation" : "governed-mutation",
        subject: `${mutation.domain}:${mutation.path}`,
        detail: `${mutation.kind} between pre- and post-capture (${mutation.beforeSha256 ?? "absent"} -> ${mutation.afterSha256 ?? "absent"})`,
      });
    }
    validateLease(input.lease, input.before, input.after, input.now, violations);
  }

  return {
    valid: violations.length === 0,
    violations,
    mutations,
    blockedReasons: violations.map(formatBlockedReason),
  };
}

export function sealEvidenceDigest(bundle: FrozenCandidateBundle): string {
  if (bundle.capturePhase !== "post-capture") {
    throw new GameManifestContractViolation([
      {
        code: "capture-phase-mismatch",
        subject: bundle.capturePhase,
        detail: "evidence may only be sealed from the post-capture bundle",
      },
    ]);
  }
  return bundle.manifests[EVIDENCE_MANIFEST_DOMAIN].digest;
}

export function assertManifestIntegrity(input: CriticRoundInput): void {
  const report = evaluateManifestIntegrity(input);
  if (!report.valid) {
    throw new GameManifestContractViolation(report.violations);
  }
}

export function gateCriticRound(input: CriticRoundInput): CriticRoundDecision {
  const report = evaluateManifestIntegrity(input);
  return {
    allowed: report.valid,
    terminalState: report.valid ? null : "INVALID_EVIDENCE",
    scoresSuppressed: !report.valid,
    promotionBlocked: !report.valid,
    incumbentHash: input.incumbentHash,
    rollbackReference: input.rollbackReference,
    report,
  };
}

const AXIOM_VEIL_CANDIDATE_ID = "axiom-veil-slice-0004";

const AXIOM_VEIL_DOMAIN_CONTENT: Record<GovernedManifestDomain, readonly (readonly [string, string])[]> = {
  "candidate-source": [
    ["src/contracts.ts", "export const M = 40;\n"],
    ["src/game/player.ts", "export const runSpeedMetres = 7.5;\n"],
    ["src/game/cameraDirector.ts", "export const lookaheadMetres = 3.2;\n"],
  ],
  "candidate-assets": [
    ["assets/atlas/player.png", "player-atlas-bytes"],
    ["assets/audio/counter.ogg", "counter-audio-bytes"],
  ],
  "reference-corpus": [["reference/README.md", "private reference media, not shippable art\n"]],
  harness: [
    ["harness/browser-smoke.ts", "export const smoke = true;\n"],
    ["harness/frame-advance.ts", "export const advance = true;\n"],
  ],
  "production-controls": [["src/input/controlMap.ts", "export const counter = 'KeyJ';\n"]],
  rubrics: [["rubrics/visual.v3.json", '{"version":"3","lens":"visual"}\n']],
  scenarios: [
    ["scenarios/route-to-boss.json", '{"id":"route-to-boss"}\n'],
    ["scenarios/counter-damage.json", '{"id":"counter-damage"}\n'],
  ],
  evidence: [],
};

function frozenManifestsFrom(
  overrides: Partial<Record<GovernedManifestDomain, readonly (readonly [string, string])[]>> = {},
): Record<GovernedManifestDomain, FrozenManifest> {
  const manifests = {} as Record<GovernedManifestDomain, FrozenManifest>;
  for (const domain of GOVERNED_MANIFEST_DOMAINS) {
    const files = overrides[domain] ?? AXIOM_VEIL_DOMAIN_CONTENT[domain];
    manifests[domain] = freezeManifest(
      domain,
      files.map(([path, content]) => manifestEntryFromContent(path, content)),
    );
  }
  return manifests;
}

const CAPTURED_EVIDENCE: readonly (readonly [string, string])[] = [
  ["evidence/active-play.webm", "active-play-capture-bytes"],
  ["evidence/boss-counter.json", '{"counterSuccess":true,"bossHealthDelta":-18}\n'],
];

export const AXIOM_VEIL_PRE_CAPTURE_BUNDLE: FrozenCandidateBundle = freezeCandidateBundle(
  AXIOM_VEIL_CANDIDATE_ID,
  "pre-capture",
  frozenManifestsFrom(),
);

export const AXIOM_VEIL_POST_CAPTURE_BUNDLE: FrozenCandidateBundle = freezeCandidateBundle(
  AXIOM_VEIL_CANDIDATE_ID,
  "post-capture",
  frozenManifestsFrom({ evidence: CAPTURED_EVIDENCE }),
);

export const AXIOM_VEIL_SOURCE_MUTATED_BUNDLE: FrozenCandidateBundle = freezeCandidateBundle(
  AXIOM_VEIL_CANDIDATE_ID,
  "post-capture",
  frozenManifestsFrom({
    evidence: CAPTURED_EVIDENCE,
    "candidate-source": [
      ["src/contracts.ts", "export const M = 40;\n"],
      ["src/game/player.ts", "export const runSpeedMetres = 9.25;\n"],
      ["src/game/cameraDirector.ts", "export const lookaheadMetres = 3.2;\n"],
    ],
  }),
);

export const AXIOM_VEIL_CONTROLS_MUTATED_BUNDLE: FrozenCandidateBundle = freezeCandidateBundle(
  AXIOM_VEIL_CANDIDATE_ID,
  "post-capture",
  frozenManifestsFrom({
    evidence: CAPTURED_EVIDENCE,
    "production-controls": [["src/input/controlMap.ts", "export const counter = 'KeyK';\n"]],
  }),
);

export const AXIOM_VEIL_EVIDENCE_OVERWRITTEN_BUNDLE: FrozenCandidateBundle = freezeCandidateBundle(
  AXIOM_VEIL_CANDIDATE_ID,
  "post-capture",
  frozenManifestsFrom({
    evidence: [
      ["evidence/active-play.webm", "active-play-capture-bytes"],
      ["evidence/boss-counter.json", '{"counterSuccess":true,"bossHealthDelta":0}\n'],
    ],
  }),
);

export const AXIOM_VEIL_CRITIC_LEASE: CriticLease = issueCriticLease(AXIOM_VEIL_PRE_CAPTURE_BUNDLE, {
  leaseId: "lease-axiom-veil-visual-01",
  criticId: "critic-visual",
  lens: "visual",
  issuedAt: "2026-08-13T00:00:00.000Z",
  ttlSeconds: 3600,
});

export const AXIOM_VEIL_SEALED_EVIDENCE_DIGEST = sealEvidenceDigest(AXIOM_VEIL_POST_CAPTURE_BUNDLE);

export const AXIOM_VEIL_VALID_ROUND: CriticRoundInput = {
  before: AXIOM_VEIL_PRE_CAPTURE_BUNDLE,
  after: AXIOM_VEIL_POST_CAPTURE_BUNDLE,
  lease: AXIOM_VEIL_CRITIC_LEASE,
  now: "2026-08-13T00:10:00.000Z",
  incumbentHash: "sha256:incumbent-axiom-veil-slice-0003",
  rollbackReference: "git:refs/tags/axiom-veil-slice-0003",
  sealedEvidenceDigest: AXIOM_VEIL_SEALED_EVIDENCE_DIGEST,
};
