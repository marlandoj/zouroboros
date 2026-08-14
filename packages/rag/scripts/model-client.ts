/**
 * model-client.ts — dual-home re-export shim.
 *
 * The live multi-provider model client lives in the zo-memory-system Skill.
 * This package mirrors the RAG runtime scripts for durable version history and
 * library packaging; at runtime they resolve the same client the Skill uses.
 * This matches the convention in `rag-core.ts`, which loads the same module by
 * absolute path. Keeping the runtime scripts byte-identical to their Skill
 * origin lets the two homes be diffed and re-synced without drift.
 */
export * from "/home/workspace/Skills/zo-memory-system/scripts/model-client.ts";
