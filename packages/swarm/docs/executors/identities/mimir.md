# Mimir Executor Capability Guide

## Production identity

- Executor ID: `mimir`
- Runtime: Zouroboros internal memory transport
- Transport: authenticated HTTP request to the memory gate
- Indexed API corpus: `zouroboros/mimir-transport`
- Default endpoint: `http://localhost:7820`

## Best use

Use Mimir as a read-only DAG node that injects cross-session history, institutional knowledge, and prior project context into downstream work. Mimir is not a general coding harness and should not receive mutation tasks.

## Runtime API surface

The indexed internal API covers:

- `MimirTransport.execute()` task-to-gate requests
- bearer authentication from the memory-gate token
- persona selection with `persona: "mimir"`
- bounded request timeouts
- gate exit-code interpretation
- empty-context success semantics
- backend health checks and fact counts
- transport factory wiring through `MIMIR_GATE_URL`
- memory-gate request, briefing, and response contracts

## Swarm usage

The swarm transport posts the task text to `/gate`. Exit code `0` with output returns retrieved context. A valid empty result is still a successful execution with an explicit no-context response. Network, authentication, and non-success HTTP responses fail the task.

## Boundaries

- Mimir is read-only and does not modify memory during executor dispatch.
- A healthy HTTP server is insufficient if the Mimir backend is absent.
- Empty relevant context is not a transport failure.
- Any change to gate authentication, response semantics, or backend selection requires memory and transport verification before promotion.
