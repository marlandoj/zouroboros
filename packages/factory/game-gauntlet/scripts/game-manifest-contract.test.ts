import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AXIOM_VEIL_CONTROLS_MUTATED_BUNDLE,
  AXIOM_VEIL_CRITIC_LEASE,
  AXIOM_VEIL_EVIDENCE_OVERWRITTEN_BUNDLE,
  AXIOM_VEIL_POST_CAPTURE_BUNDLE,
  AXIOM_VEIL_PRE_CAPTURE_BUNDLE,
  AXIOM_VEIL_SEALED_EVIDENCE_DIGEST,
  AXIOM_VEIL_SOURCE_MUTATED_BUNDLE,
  AXIOM_VEIL_VALID_ROUND,
  CANDIDATE_MANIFEST_DOMAINS,
  GAME_MANIFEST_CONTRACT_VERSION,
  GOVERNED_MANIFEST_DOMAINS,
  GameManifestContractViolation,
  assertManifestIntegrity,
  collectGovernedMutations,
  computeManifestDigest,
  evaluateManifestIntegrity,
  freezeCandidateBundle,
  freezeManifest,
  gateCriticRound,
  issueCriticLease,
  manifestEntriesFromFiles,
  manifestEntryFromContent,
  revokeCriticLease,
  sealEvidenceDigest,
  sha256Hex,
  type CriticRoundInput,
  type FrozenManifest,
  type GameManifestViolationCode,
  type GovernedManifestDomain,
} from "./game-manifest-contract";

function codes(input: CriticRoundInput): GameManifestViolationCode[] {
  return evaluateManifestIntegrity(input).violations.map((violation) => violation.code);
}

function withManifest(
  bundle: typeof AXIOM_VEIL_PRE_CAPTURE_BUNDLE,
  domain: GovernedManifestDomain,
  manifest: FrozenManifest,
): typeof AXIOM_VEIL_PRE_CAPTURE_BUNDLE {
  return freezeCandidateBundle(bundle.candidateId, bundle.capturePhase, {
    ...bundle.manifests,
    [domain]: manifest,
  });
}

describe("governed manifest coverage", () => {
  test("hashes every domain the acceptance criteria names", () => {
    expect([...GOVERNED_MANIFEST_DOMAINS]).toEqual([
      "candidate-source",
      "candidate-assets",
      "reference-corpus",
      "harness",
      "production-controls",
      "rubrics",
      "scenarios",
      "evidence",
    ]);
    expect([...CANDIDATE_MANIFEST_DOMAINS]).not.toContain("evidence");
    for (const domain of GOVERNED_MANIFEST_DOMAINS) {
      expect(AXIOM_VEIL_PRE_CAPTURE_BUNDLE.manifests[domain].domain).toBe(domain);
      expect(AXIOM_VEIL_POST_CAPTURE_BUNDLE.manifests[domain].domain).toBe(domain);
    }
  });

  test("hashes real files off disk", () => {
    const root = mkdtempSync(join(tmpdir(), "game-manifest-"));
    try {
      writeFileSync(join(root, "controlMap.ts"), "export const counter = 'KeyJ';\n");
      const [entry] = manifestEntriesFromFiles(root, ["controlMap.ts"]);
      expect(entry.sha256).toBe(sha256Hex("export const counter = 'KeyJ';\n"));
      expect(entry.bytes).toBe(31);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("digests are content-addressed and order-independent", () => {
    const forward = freezeManifest("scenarios", [
      manifestEntryFromContent("a.json", "{}"),
      manifestEntryFromContent("b.json", "[]"),
    ]);
    const reversed = freezeManifest("scenarios", [
      manifestEntryFromContent("b.json", "[]"),
      manifestEntryFromContent("a.json", "{}"),
    ]);
    expect(forward.digest).toBe(reversed.digest);
    expect(forward.digest).toBe(computeManifestDigest("scenarios", forward.entries));

    const changed = freezeManifest("scenarios", [
      manifestEntryFromContent("a.json", "{}"),
      manifestEntryFromContent("b.json", "[1]"),
    ]);
    expect(changed.digest).not.toBe(forward.digest);
  });

  test("frozen manifests and leases reject in-place writes", () => {
    const manifest = AXIOM_VEIL_PRE_CAPTURE_BUNDLE.manifests["candidate-source"];
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    expect(Object.isFrozen(AXIOM_VEIL_PRE_CAPTURE_BUNDLE)).toBe(true);
    expect(Object.isFrozen(AXIOM_VEIL_CRITIC_LEASE)).toBe(true);
    expect(() => {
      "use strict";
      (manifest.entries[0] as { sha256: string }).sha256 = "0".repeat(64);
    }).toThrow();
  });

  test("fails closed on empty, duplicated, or malformed manifests", () => {
    expect(() => freezeManifest("harness", [])).toThrow(GameManifestContractViolation);
    expect(() =>
      freezeManifest("harness", [
        manifestEntryFromContent("smoke.ts", "a"),
        manifestEntryFromContent("smoke.ts", "b"),
      ]),
    ).toThrow(GameManifestContractViolation);
    expect(() => freezeManifest("harness", [{ path: "smoke.ts", sha256: "not-a-digest", bytes: 1 }])).toThrow(
      GameManifestContractViolation,
    );
    expect(() => freezeCandidateBundle("candidate", "pre-capture", {})).toThrow(GameManifestContractViolation);
  });
});

describe("immutable critic lease", () => {
  test("binds a read-only lease to the pre-capture content address", () => {
    expect(AXIOM_VEIL_CRITIC_LEASE.accessMode).toBe("read-only");
    expect(AXIOM_VEIL_CRITIC_LEASE.contractVersion).toBe(GAME_MANIFEST_CONTRACT_VERSION);
    expect(AXIOM_VEIL_CRITIC_LEASE.candidateDigest).toBe(AXIOM_VEIL_PRE_CAPTURE_BUNDLE.candidateDigest);
    expect(AXIOM_VEIL_CRITIC_LEASE.expiresAt).toBe("2026-08-13T01:00:00.000Z");
  });

  test("refuses to issue a lease against a post-capture bundle or a non-positive ttl", () => {
    expect(() =>
      issueCriticLease(AXIOM_VEIL_POST_CAPTURE_BUNDLE, {
        leaseId: "lease-late",
        criticId: "critic-visual",
        lens: "visual",
        issuedAt: "2026-08-13T00:00:00.000Z",
        ttlSeconds: 60,
      }),
    ).toThrow(GameManifestContractViolation);
    expect(() =>
      issueCriticLease(AXIOM_VEIL_PRE_CAPTURE_BUNDLE, {
        leaseId: "lease-zero",
        criticId: "critic-visual",
        lens: "visual",
        issuedAt: "2026-08-13T00:00:00.000Z",
        ttlSeconds: 0,
      }),
    ).toThrow(GameManifestContractViolation);
  });

  test("expired and revoked leases invalidate the round", () => {
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, now: "2026-08-13T02:00:00.000Z" })).toEqual(["lease-expired"]);
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, lease: revokeCriticLease(AXIOM_VEIL_CRITIC_LEASE, "critic wrote to source") })).toEqual([
      "lease-revoked",
    ]);
  });

  test("a write-capable or foreign lease invalidates the round", () => {
    expect(
      codes({
        ...AXIOM_VEIL_VALID_ROUND,
        lease: { ...AXIOM_VEIL_CRITIC_LEASE, accessMode: "read-write" as never },
      }),
    ).toEqual(["lease-write-access"]);
    expect(
      codes({
        ...AXIOM_VEIL_VALID_ROUND,
        lease: { ...AXIOM_VEIL_CRITIC_LEASE, candidateId: "some-other-candidate" },
      }),
    ).toEqual(["lease-candidate-mismatch"]);
    expect(
      codes({
        ...AXIOM_VEIL_VALID_ROUND,
        lease: { ...AXIOM_VEIL_CRITIC_LEASE, candidateDigest: sha256Hex("forged") },
      }),
    ).toEqual(["lease-digest-mismatch", "lease-digest-mismatch"]);
  });
});

describe("pre- and post-capture verification", () => {
  test("an untouched candidate plus newly captured evidence stays valid", () => {
    const report = evaluateManifestIntegrity(AXIOM_VEIL_VALID_ROUND);
    expect(report.violations).toEqual([]);
    expect(report.mutations).toEqual([]);
    expect(report.valid).toBe(true);
    expect(() => assertManifestIntegrity(AXIOM_VEIL_VALID_ROUND)).not.toThrow();
    expect(AXIOM_VEIL_POST_CAPTURE_BUNDLE.candidateDigest).toBe(AXIOM_VEIL_PRE_CAPTURE_BUNDLE.candidateDigest);
    expect(AXIOM_VEIL_POST_CAPTURE_BUNDLE.bundleDigest).not.toBe(AXIOM_VEIL_PRE_CAPTURE_BUNDLE.bundleDigest);
  });

  test("detects source mutation during active criticism", () => {
    const mutations = collectGovernedMutations(AXIOM_VEIL_PRE_CAPTURE_BUNDLE, AXIOM_VEIL_SOURCE_MUTATED_BUNDLE);
    expect(mutations).toEqual([
      {
        domain: "candidate-source",
        path: "src/game/player.ts",
        kind: "modified",
        beforeSha256: sha256Hex("export const runSpeedMetres = 7.5;\n"),
        afterSha256: sha256Hex("export const runSpeedMetres = 9.25;\n"),
      },
    ]);
  });

  test("detects a stale control map swapped in after the lease was issued", () => {
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, after: AXIOM_VEIL_CONTROLS_MUTATED_BUNDLE })).toContain("governed-mutation");
  });

  test("evidence may be added by capture but never rewritten once sealed", () => {
    expect(collectGovernedMutations(AXIOM_VEIL_PRE_CAPTURE_BUNDLE, AXIOM_VEIL_POST_CAPTURE_BUNDLE)).toEqual([]);
    expect(AXIOM_VEIL_SEALED_EVIDENCE_DIGEST).toBe(AXIOM_VEIL_POST_CAPTURE_BUNDLE.manifests.evidence.digest);
    expect(() => sealEvidenceDigest(AXIOM_VEIL_PRE_CAPTURE_BUNDLE)).toThrow(GameManifestContractViolation);

    expect(
      collectGovernedMutations(AXIOM_VEIL_POST_CAPTURE_BUNDLE, AXIOM_VEIL_EVIDENCE_OVERWRITTEN_BUNDLE),
    ).toEqual([
      {
        domain: "evidence",
        path: "evidence/boss-counter.json",
        kind: "modified",
        beforeSha256: sha256Hex('{"counterSuccess":true,"bossHealthDelta":-18}\n'),
        afterSha256: sha256Hex('{"counterSuccess":true,"bossHealthDelta":0}\n'),
      },
    ]);
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, after: AXIOM_VEIL_EVIDENCE_OVERWRITTEN_BUNDLE })).toEqual([
      "evidence-mutation",
    ]);
  });

  test("a tampered manifest digest fails before any diff is trusted", () => {
    const forged: FrozenManifest = {
      ...AXIOM_VEIL_PRE_CAPTURE_BUNDLE.manifests.rubrics,
      digest: sha256Hex("forged-rubric-digest"),
    };
    const bundle = {
      ...AXIOM_VEIL_POST_CAPTURE_BUNDLE,
      manifests: { ...AXIOM_VEIL_POST_CAPTURE_BUNDLE.manifests, rubrics: forged },
    };
    const violations = codes({ ...AXIOM_VEIL_VALID_ROUND, after: bundle });
    expect(violations).toContain("digest-mismatch");
    expect(violations).not.toContain("governed-mutation");
  });

  test("a rewritten rubric with a recomputed digest still fails as a governed mutation", () => {
    const rubrics = freezeManifest("rubrics", [
      manifestEntryFromContent("rubrics/visual.v3.json", '{"version":"3","lens":"visual","weights":"rebalanced"}\n'),
    ]);
    const after = withManifest(AXIOM_VEIL_POST_CAPTURE_BUNDLE, "rubrics", rubrics);
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, after })).toEqual([
      "governed-mutation",
      "lease-digest-mismatch",
    ]);
  });

  test("mismatched capture phases and candidate identities fail closed", () => {
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, after: AXIOM_VEIL_PRE_CAPTURE_BUNDLE })).toEqual([
      "capture-phase-mismatch",
      "evidence-mutation",
    ]);
    const otherCandidate = freezeCandidateBundle("axiom-veil-slice-0005", "post-capture", {
      ...AXIOM_VEIL_POST_CAPTURE_BUNDLE.manifests,
    });
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, after: otherCandidate })).toEqual([
      "candidate-identity-mismatch",
      "lease-candidate-mismatch",
    ]);
  });

  test("an unknown contract version fails closed", () => {
    const stale = { ...AXIOM_VEIL_POST_CAPTURE_BUNDLE, contractVersion: 2 as never };
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, after: stale })).toEqual(["unknown-version"]);
  });
});

describe("governed mutation suppresses scoring and promotion", () => {
  test("a clean round leaves scoring and promotion eligible", () => {
    const decision = gateCriticRound(AXIOM_VEIL_VALID_ROUND);
    expect(decision).toMatchObject({
      allowed: true,
      terminalState: null,
      scoresSuppressed: false,
      promotionBlocked: false,
      incumbentHash: "sha256:incumbent-axiom-veil-slice-0003",
      rollbackReference: "git:refs/tags/axiom-veil-slice-0003",
    });
  });

  test.each([
    ["candidate source", AXIOM_VEIL_SOURCE_MUTATED_BUNDLE],
    ["production controls", AXIOM_VEIL_CONTROLS_MUTATED_BUNDLE],
  ])("mutating %s returns INVALID_EVIDENCE and retains the incumbent", (_label, after) => {
    const decision = gateCriticRound({ ...AXIOM_VEIL_VALID_ROUND, after });
    expect(decision.allowed).toBe(false);
    expect(decision.terminalState).toBe("INVALID_EVIDENCE");
    expect(decision.scoresSuppressed).toBe(true);
    expect(decision.promotionBlocked).toBe(true);
    expect(decision.incumbentHash).toBe("sha256:incumbent-axiom-veil-slice-0003");
    expect(decision.rollbackReference).toBe("git:refs/tags/axiom-veil-slice-0003");
    expect(decision.report.mutations.length).toBeGreaterThan(0);
    expect(decision.report.blockedReasons.some((reason) => reason.startsWith("governed-mutation:"))).toBe(true);
  });

  test("mutating any single governed hash invalidates the round", () => {
    for (const domain of GOVERNED_MANIFEST_DOMAINS) {
      const original = AXIOM_VEIL_POST_CAPTURE_BUNDLE.manifests[domain];
      const mutated = freezeManifest(domain, [
        ...original.entries.slice(1),
        manifestEntryFromContent(original.entries[0]?.path ?? `${domain}/injected`, `mutated-${domain}`),
      ]);
      const decision = gateCriticRound({
        ...AXIOM_VEIL_VALID_ROUND,
        after: withManifest(AXIOM_VEIL_POST_CAPTURE_BUNDLE, domain, mutated),
      });
      expect([domain, decision.terminalState]).toEqual([domain, "INVALID_EVIDENCE"]);
      expect(decision.scoresSuppressed).toBe(true);
      expect(decision.promotionBlocked).toBe(true);
      expect(decision.incumbentHash).toBe(AXIOM_VEIL_VALID_ROUND.incumbentHash);
      expect(decision.rollbackReference).toBe(AXIOM_VEIL_VALID_ROUND.rollbackReference);
    }
  });

  test("a missing incumbent or rollback reference blocks promotion on its own", () => {
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, incumbentHash: "  " })).toEqual(["missing-incumbent"]);
    expect(codes({ ...AXIOM_VEIL_VALID_ROUND, rollbackReference: "" })).toEqual(["missing-rollback-reference"]);
    const decision = gateCriticRound({ ...AXIOM_VEIL_VALID_ROUND, incumbentHash: "", rollbackReference: "" });
    expect(decision.terminalState).toBe("INVALID_EVIDENCE");
    expect(decision.promotionBlocked).toBe(true);
  });
});
