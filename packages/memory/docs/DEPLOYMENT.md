# Memory Daemon Deployment

## Model routing

All LLM-backed workloads (gate classifier, session briefing, extraction, summarization, capture, conversation, HyDE) route through `model-client.ts`, which selects a provider + model from env vars:

| Env var | Default | Workload |
|---|---|---|
| `ZO_MODEL_GATE` | `openai:gpt-4o-mini` | Memory gate classifier |
| `ZO_MODEL_BRIEFING` | `openai:gpt-4o-mini` | Session briefing generation |
| `ZO_MODEL_EXTRACTION` | `openai:gpt-4o-mini` | Fact extraction |
| `ZO_MODEL_SUMMARIZATION` | `openai:gpt-4o-mini` | Episode summarization |
| `ZO_MODEL_HYDE` | `openai:gpt-4o-mini` | HyDE query expansion |
| `ZO_MODEL_CAPTURE` | `openai:gpt-4o-mini` | Inline capture |
| `ZO_MODEL_CONVERSATION` | `openai:gpt-4o-mini` | Conversation capture |
| `ZO_MODEL_EMBEDDING` | `openai:text-embedding-3-small` | Embeddings (OpenAI 1536d) |

Model spec format: `provider:model-id` (e.g. `openai:gpt-4o-mini` or `anthropic:claude-haiku-4-5`).

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

If an OpenAI provider call throws inside `generate()` (e.g. missing API key, rate limit), the daemon logs the error to stderr and returns an empty/error result — there is no Ollama fallback. Monitor for errors:

```
[model-client] openai workload=gate failed: <message>
```

Tail `/dev/shm/memory-gate_err.log` (or equivalent) to catch regressions early. Ensure `OPENAI_API_KEY` is set in the service's `env_vars`.

## Scorecard label

Gate decisions that went through the LLM classifier are now tagged `method: "llm_classifier"` in the scorecard (previously `"ollama_classifier"`, which was misleading after the migration).
