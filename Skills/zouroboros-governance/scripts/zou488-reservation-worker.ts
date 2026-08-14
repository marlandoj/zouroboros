#!/usr/bin/env bun
import * as fs from "node:fs";
import {
  consumeAuthorization,
  parseAuthorizationEvidence,
  verifyAuthorization,
  type AuthorizationExpectation,
} from "./autonomy-authorization";

interface ReservationFixture {
  evidence: unknown;
  expected: AuthorizationExpectation;
}

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("reservation fixture path is required");
  process.exit(2);
}

try {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ReservationFixture;
  const evidence = parseAuthorizationEvidence(fixture.evidence);
  if (!evidence) throw new Error("authorization evidence is malformed");
  const verified = verifyAuthorization(evidence, fixture.expected, { requireUnused: false });
  if (!verified.valid) throw new Error(verified.reason);
  consumeAuthorization(evidence);
  process.stdout.write("reserved\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
