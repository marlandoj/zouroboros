---
name: zo-to-zo-consult
description: Establish and operate expiring, human-consented, read-only troubleshooting consultations between AI personas on separate Zo Computers. Use when one Zo persona should consult another directly without sharing Zo access tokens, exposing mutation tools, or allowing either agent to execute proposed changes.
---

# Zo-to-Zo Consult

Use a brokered session in which both participating personas are chat-only clones. Pass only a narrow invitation token between hosts. Never share either host's Zo API or MCP access token.

## Establish a session

1. Read the applicable workspace governance documents before changing Zouroboros routing, prompts, or gates.
2. Create a dedicated consultant persona on the receiving Zo and set its scopes to an empty list.
3. Generate an invitation with `scripts/create-invite.ts`:

```bash
bun scripts/create-invite.ts \
  --alaric-persona-id <persona-id> \
  --out-client /home/workspace/Documents/Zo-to-Zo/phyre-alaric-consult.ts \
  --out-env /home/workspace/.zo/consult-sessions/broker-env.json
```

4. Expose the broker through a dedicated public HTTP User Service when capacity exists. If the host is at its service limit, create an authenticated Zo Space API route with the same hash, expiry, turn, redaction, and no-execution controls. Never put the raw invitation token in either runtime.
5. Run `scripts/finalize-invite.ts` to bind the generated client to the resulting HTTPS consultation endpoint.
6. Deliver the client privately to the peer owner. Never publish an invitation client through zo.pub, a public route, a repository, or a paste service.

The broker invitation expires at the generated timestamp. Its first valid request activates a shorter consultation window. The broker enforces a turn cap, request-size limit, replay detection, rate limit, peer identity header, secret redaction, and a local audit transcript.

## Peer consent

Have the peer Zo owner run the generated client:

```bash
bun phyre-alaric-consult.ts \
  --issue "Describe the system problem" \
  --evidence /home/workspace/path/to/redacted-log.json
```

Treat this command as affirmative consent to:

- read only the explicitly named evidence files;
- create a temporary clone of the source persona;
- set the clone to chat-only scopes;
- conduct the bounded consultation;
- delete the temporary clone when the consultation ends.

The peer's local Zo token remains on the peer host. The client never sends it to the broker.

## Human gate

Neither broker exposes an execution endpoint. Both temporary personas have empty tool scopes. Every proposed change must include action, rationale, risk, rollback, verification, and `HUMAN APPROVAL REQUIRED`.

Stop after producing a recommendation. A human must separately approve and execute any command, edit, deployment, configuration change, communication, or other mutation on the affected Zo.

## Evidence rules

Accept evidence only when the owner names each file with `--evidence`. Restrict evidence to regular files under `/home/workspace` or `/dev/shm`, cap individual files at 64 KiB and the combined payload at 128 KiB, and redact common credential patterns before transmission.

If more evidence is required, stop and ask the owner for a new explicit run. Do not add shell execution, directory crawling, implicit log collection, or tool scopes to make the consultation more convenient.

## Verify

Run:

```bash
bun test scripts/broker.test.ts
bunx tsc -p tsconfig.json
```

Generate a disposable invitation and run the generated client's `--dry-run` path. Confirm the service health endpoint reports `consult_only: true` and `execute_endpoint: false`.

## Revoke

Revoke a session by stopping or deleting its broker service. Delete the dedicated consultant persona after no live session depends on it. Preserve the redacted audit transcript according to the owners' retention decision.
