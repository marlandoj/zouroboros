# Executor Capability and Routing Matrix

This document describes the eight active swarm executors, the capabilities exposed by their production transports, and how the DAG chooses an executor and model for each task.

## Capability matrix

| Executor | Production transport | Best fit | Production tools | Hierarchical delegation | Model route | Indexed SDK or API corpus |
|---|---|---|---|---|---|---|
| `claude-code` | ACP via `claude-agent-acp` | Architecture, complex multi-file implementation, review, debugging, and repository operations | File read/write, shell, MCP, streaming | Conditional parent; summary-only child telemetry | Haiku for trivial/simple/failover, Sonnet for moderate/complex; explicit Claude model names remain allowed | `@anthropic-ai/claude-agent-sdk@0.3.220` |
| `hermes` | Native ACP via `hermes acp --accept-hooks` | Web research, external tools, investigation, security review, multimodal work, and long autonomous workflows | File read/write, shell, web/browser, image, MCP, streaming, messaging, and scheduled tools | Enabled parent; bounded child records | `light`, `mid`, and `heavy` aliases resolved by Hermes provider routing; `swarm-failover` on failover | Live `hermes-agent@0.19.0` source |
| `gemini` | Native ACP via `gemini --acp` | Large-context analysis, multimodal review, research synthesis, UI work, and independent cross-checks | File read/write, shell, web, MCP, streaming, policy and sandbox services | Leaf | Flash for trivial/simple/failover; Pro for moderate/complex | `@google/gemini-cli-core@0.50.0` |
| `codex` | ACP via `codex-acp` | Fast repository implementation, backend work, refactoring, shell automation, and focused review | File read/write, shell, MCP, streaming | Leaf | Codex Mini for trivial/simple/failover, GPT-5.3 Codex for moderate, GPT-5.4 for complex | `@openai/codex-sdk@0.144.0` |
| `opencode` | Native ACP via `opencode acp --pure` | Vendor-neutral coding, harness-controlled model comparisons, and provider-pinned implementation | File read/write, shell, web, MCP, streaming | Leaf | GPT-OSS 20B for trivial, GLM-5.2 for simple/moderate, Grok Build for complex/failover; provider-qualified passthrough | `@opencode-ai/sdk@1.18.4` |
| `kimi` | Native ACP through the Kimi bridge | Large-context and long-running coding, multimodal analysis, Moonshot-family review, and repository-wide debugging | File read/write, shell, web, shared MCP roster, authenticated Zo tools, memory briefing, streaming | Leaf; SDK agent-loop primitives are not wired into DAG delegation | Kimi K3 for every tier; model is session-scoped while provider endpoint and credentials are launch-scoped | `kimi-sdk==0.2.1` |
| `pi` | Isolated one-shot bridge with Pi MCP adapter | Fast focused implementation, ephemeral review, minimal-harness comparisons, and cross-provider coding | File read/write, shell, web, shared MCP roster, authenticated Zo tools, memory briefing; final-result transport | Leaf; SDK sessions and extensions are not wired into DAG delegation | OpenRouter Kimi K3 by default; provider-qualified task overrides; Kimi Latest failover | `@earendil-works/pi-coding-agent@0.82.1` |
| `mimir` | Authenticated memory-gate HTTP transport | Read-only historical context, institutional memory, prior decisions, and semantic-drift checks | Memory gate only; no repository mutation | Leaf | No model route in the swarm; the memory gate owns backend selection | Internal `zouroboros/mimir-transport` API |

## DAG executor selection

The selector applies these controls in order:

1. An explicit `task.executor` wins, subject to persona tool restrictions and circuit-breaker fallback.
2. A role-registry executor is a hard choice when no routing engine is present. With the routing engine enabled, role affinity becomes a scored signal instead.
3. Without the routing engine, budget below 20 percent forces the cheapest healthy eligible executor.
4. The routing engine scores every auto-routable executor. It normally uses six signals: capability, health, complexity fit, history, procedure knowledge, and temporal health. When budget or role context exists, budget and role affinity extend the decision to eight signals.
5. If no routing engine is supplied, legacy tag matching selects among all eight registered executors.
6. Persona restrictions remove executors whose declared tools violate the persona boundary. An open circuit breaker advances through the executor-specific fallback chain.

OpenCode participates in automatic routing only when `SWARM_OPENCODE_ENABLED=1`. The other seven active executors have no rollout gate. Mimir should be selected only for read-only memory tasks.

## Model selection and dispatch

After selecting the executor, the orchestrator resolves the model in this order:

1. Explicit `task.model`.
2. Role-registry model.
3. Executor tier map derived from task complexity.
4. Executor default or compatible fallback.

The DAG passes the resolved value to every transport as `SWARM_RESOLVED_MODEL`. ACP adapters apply it through an environment variable, ACP session configuration, or an ACP extension according to the registry. Bridge executors receive the same task-scoped environment value. A fallback executor re-resolves the model against its own accepted model family before dispatch.

## Subagents and SDK boundaries

Hierarchical DAG delegation is a control-plane feature, not an automatic consequence of an SDK exposing sessions or agents. Only Hermes and Claude Code currently have production delegation profiles. Kimi, Pi, Gemini, Codex, OpenCode, and Mimir remain leaf executors until their child-task lifecycle, write isolation, cancellation, telemetry, and recursion limits are separately implemented and promoted.

SDK sources are indexed in RAG for implementation and routing knowledge. Indexing an SDK does not switch the production transport from ACP or bridge execution to direct SDK embedding.
