# zouroboros-memory

Hybrid SQLite + vector memory for Zouroboros, plus a standalone **memory-gate
daemon** that injects prior context into any host's prompts via a
`UserPromptSubmit`-style hook.

The package ships three executables:

| bin | purpose |
|---|---|
| `zouroboros-memory` | memory CLI (search, store, stats, …) |
| `zouroboros-memory-mcp` | MCP server (stdio) |
| `zouroboros-memory-gate` | HTTP gate daemon (this document) |

## The memory-gate daemon

A small HTTP service that classifies an incoming prompt, retrieves relevant
stored facts, and returns them for injection. It is built entirely on this
package's own library exports — no external services required. Vector retrieval
is used when `OPENAI_API_KEY` is set; otherwise it degrades to text/FTS search.

### Start it

After `npm i -g zouroboros-cli && zouroboros init`:

```bash
zouroboros gate start            # foreground, port 7820
zouroboros gate start --port 8100
zouroboros gate status           # GET /health

# or directly:
zouroboros-memory-gate
```

`zouroboros init` generates a `ZO_GATE_TOKEN` into `~/.zouroboros/.env`. Source
it (or export the token) before starting the daemon:

```bash
set -a; . ~/.zouroboros/.env; set +a
zouroboros gate start
```

### Configuration

| env / flag | default | meaning |
|---|---|---|
| `PORT` | `7820` | listen port |
| `ZO_GATE_HOST` | `127.0.0.1` | bind host |
| `ZO_GATE_TOKEN` | — | bearer token; **fail-closed** when unset |
| `ZOUROBOROS_MEMORY_DB` / `ZO_MEMORY_DB` | `~/.zouroboros/memory.db` | backend DB |
| `--insecure` | off | disable auth **and** force a `127.0.0.1` bind (localhost dev only) |

Auth is fail-closed: with no token set, protected endpoints deny every request.
The `--insecure` flag is a documented escape hatch for single-user local
installs — it turns auth off but refuses to bind anywhere except loopback, so an
unauthenticated daemon is never reachable off-box. Off by default.

### Endpoints

```
GET  /health    open        → { status, uptime_s, port, backend, vector_enabled, auth }
POST /gate      bearer      → { exit_code, method, output, latency_ms, backend }
POST /briefing  bearer      → { exit_code, output, latency_ms, backend }
```

## Hook contract (host-agnostic)

Any host can inject memory by pointing its pre-prompt hook at the shipped shim
(`hooks/memory-gate-hook.sh`) or by implementing this contract directly:

```
stdin  (host → hook):  JSON { "prompt": "<user text>", "persona": "<slug, optional>" }
call   (hook → gate):  POST http://$HOST:$PORT/gate
                       Authorization: Bearer $ZO_GATE_TOKEN
                       body { "message": "<prompt>", "persona": "<slug>" }
resp   (gate → hook):  JSON { "exit_code": 0|2|3|1, "output": "<memory context>", ... }
                       0 = context found → inject   2 = not needed
                       3 = needed but empty          1 = error
stdout (hook → host):  if exit_code==0 && output:  <memory-gate>\n{output}\n</memory-gate>
exit                :  ALWAYS 0 (fail-open — never block the prompt)
```

The gate does **additive** context injection, not access control. A failed,
absent, or unreachable daemon injects nothing and never blocks the prompt.
When the request omits `persona`, the shim defaults it to `shared`.

### Wiring it into Claude Code

Add a `UserPromptSubmit` hook in `settings.json`, pointing at the shipped shim
(resolve its path via your global npm prefix, e.g.
`$(npm root -g)/zouroboros-memory/hooks/memory-gate-hook.sh`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/zouroboros-memory/hooks/memory-gate-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The shim reads `ZO_GATE_TOKEN` from the environment or `~/.zouroboros/.env`, and
honors `ZO_GATE_HOST` / `ZO_GATE_PORT` / `ZO_GATE_PERSONA` overrides. It requires
`jq` and `curl` on `PATH`.

### Quick verification

```bash
export ZO_GATE_TOKEN=$(openssl rand -hex 32)
zouroboros gate start &
curl -s localhost:7820/health | jq .
curl -s -X POST localhost:7820/gate \
  -H "Authorization: Bearer $ZO_GATE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"what did we decide about the deploy pipeline?","persona":"shared"}' | jq .
```

## Library

The package also exports the memory library (`initDatabase`, `searchFacts`,
`searchFactsHybrid`, episodes, graph, reranker, routing-gate, …). See
`src/index.ts` for the full surface.
