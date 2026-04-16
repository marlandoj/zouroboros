# Memory Daemon Deployment

## Model routing

All LLM-backed workloads (gate classifier, session briefing, extraction, summarization, capture, conversation, HyDE) route through `model-client.ts`, which selects a provider + model from env vars:

| Env var | Default | Workload |
|---|---|---|
| `ZO_MODEL_GATE` | `ollama:qwen2.5:1.5b` | Memory gate classifier |
| `ZO_MODEL_BRIEFING` | `ollama:qwen2.5:1.5b` | Session briefing generation |
| `ZO_MODEL_EXTRACTION` | `ollama:qwen2.5:7b` | Fact extraction |
| `ZO_MODEL_SUMMARIZATION` | `ollama:qwen2.5:7b` | Episode summarization |
| `ZO_MODEL_HYDE` | `ollama:qwen2.5:1.5b` | HyDE query expansion |
| `ZO_MODEL_CAPTURE` | `ollama:qwen2.5:3b` | Inline capture |
| `ZO_MODEL_CONVERSATION` | `ollama:qwen2.5:1.5b` | Conversation capture |
| `ZO_MODEL_EMBEDDING` | `ollama:nomic-embed-text` | Embeddings (stays local) |

Model spec format: `provider:model-id` (e.g. `openai:gpt-4o-mini`). Bare names without `:` default to Ollama.

## Required secrets

When any `ZO_MODEL_*` var points to `openai:*`, the daemon needs:

- `OPENAI_API_KEY` — set in Zo Secrets **and** on the service itself (see below).

When pointing to `anthropic:*`:

- `ZO_CLIENT_IDENTITY_TOKEN` — Zo OAuth token (auto-injected on Zo services).

## Service env_vars — critical

`register_user_service` / `update_user_service` accepts `env_vars`. **Zo Secrets are NOT automatically forwarded to user services** unless explicitly listed in `env_vars`. If `OPENAI_API_KEY` is missing from the service's `env_vars`, the OpenAI provider will throw inside `model-client.generate()` and fall back silently to Ollama.

When updating the memory-gate daemon to use OpenAI, ensure the service is registered/updated with:

```json
"env_vars": {
  "OPENAI_API_KEY": "<from Zo Secrets>",
  "ZO_MODEL_GATE": "openai:gpt-4o-mini",
  "ZO_MODEL_BRIEFING": "openai:gpt-4o-mini",
  "ZO_MODEL_EXTRACTION": "openai:gpt-4o-mini",
  "ZO_MODEL_SUMMARIZATION": "openai:gpt-4o-mini"
}
```

> `update_user_service` env_vars is a full **replace**, not merge. Always pass the complete set.

## Fallback behavior

If a non-Ollama provider call throws inside `generate()`, the daemon logs the error and falls back to Ollama with the default model for that workload. The error is now logged to stderr as:

```
[model-client] openai workload=gate failed, falling back to ollama: <message>
```

Tail `/dev/shm/memory-gate_err.log` (or equivalent) to catch regressions early.

## Scorecard label

Gate decisions that went through the LLM classifier are now tagged `method: "llm_classifier"` in the scorecard (previously `"ollama_classifier"`, which was misleading after the migration).
