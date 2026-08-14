# GraphRAG vs Vector RAG Benchmark - ZOU-623

Date: 2026-07-14
Branch: `factory/zou-623-p4-evaluation-vs-vector-rag`
Graph runner: `bun scripts/query.ts --question "<query>" --limit 3 --pretty`
Vector runner: `qdrant-rag` `rag_search` with `limit=3`

## Decision Rule

Route to graph traversal when the question asks for typed relationships, execution/ticket/gate/cost state, multi-hop joins, or proof that a live graph edge/table is absent. Route to vector RAG when the question asks for conceptual similarity, prose/code snippets, external research passages, or broad corpus recall without a known graph schema path. If a query contains both a seed entity and an open-ended concept, use vector to find candidate entities/passages first, then graph to traverse validated relationships.

Pass criteria for this audit: exactly 10 queries, 5 relational and 5 semantic; at least 3 graph wins where vector missed evidence; at least 2 vector wins where graph returned irrelevant or lower-precision evidence.

Precision@3: relevant returned contexts divided by up to three returned contexts. An explicit empty-result graph blob is relevant when the query asks whether live graph data exists.

## Query Set And Results

| ID | Type | Query | Graph evidence | Vector evidence | Hops | Graph P@3 | Vector P@3 | Winner |
|---|---|---|---|---|---:|---:|---:|---|
| R1 | relational | Which executions co-failed with factory records? | Returned failed `ZOU-414`, `ZOU-421`, `ZOU-423` executions, each linked to `SWARM` gate decisions and factory records collected `2026-07-11T04:23:56.874Z`. | Top vector hits were generic swarm executor/regression-gate code, not execution records. | 2 | 3/3 | 0/3 | Graph |
| R2 | relational | Which ZOU-414 task executions are connected to tickets and SWARM gate decisions? | Returned complete and failed `ZOU-414` executions joined to the same ticket and `SWARM` gate decision. | Top vector hits were swarm orchestrator docs/code, not `ZOU-414` execution-to-ticket-to-gate evidence. | 2 | 2/3 | 0/3 | Graph |
| R3 | relational | What cost breakdown exists for factory executions? | Returned explicit live-graph absence: no `CostEntry` nodes or `INCURRED_COST` rows exist. | Returned unrelated cost-ranking/test snippets from swarm code, not live factory cost state. | 1 | 1/1 | 0/3 | Graph |
| R4 | relational | Which tasks related to Hetzner provisioning have execution and ticket links? | Returned `ZOU-414` complete/failed and `ZOU-415` complete execution-ticket links with Hetzner branch names. | Returned Hermes identity/backlog snippets unrelated to Hetzner ticket execution links. | 1 | 3/3 | 0/3 | Graph |
| R5 | relational | Which local model inference task has both complete and failed execution attempts? | Returned `ZOU-421` complete and failed executions for `factory/zou-421-ongoing-local-model-inference-tier-4th-moa-propose`. | Returned generic failed-task handling code, not the `ZOU-421` complete/failed pair. | 1 | 2/3 | 0/3 | Graph |
| S1 | semantic | What does the Neo4j GraphRAG manifesto say is a common pattern for GraphRAG? | Returned unrelated factory tickets such as `ZOU-451` and `ZOU-414`. | Returned the manifesto passage: vector/keyword search, graph traversal of related nodes, optional PageRank-style reranking. | 0 | 0/3 | 2/3 | Vector |
| S2 | semantic | What does LightRAG compare against HyDE on comprehensiveness diversity empowerment? | Returned unrelated factory tickets. | Returned `lightrag-guo-2024.pdf` table comparing HyDE and LightRAG across comprehensiveness, diversity, empowerment, and overall. | 0 | 0/3 | 1/3 | Vector |
| S3 | semantic | What are Hermes Agent capabilities for web research and code execution? | Returned unrelated factory tickets. | Returned Hermes Agent identity passages naming research, web scraping/browser automation, code execution, and investigation capabilities. | 0 | 0/3 | 3/3 | Vector |
| S4 | semantic | What does qdrant-rag MCP end-to-end stdio validation cover? | Returned unrelated factory tickets. | Returned qdrant-rag eval and MCP server passages covering stdio path validation, initialization, server info, and tool exposure. | 0 | 0/3 | 2/3 | Vector |
| S5 | semantic | How is the swarm orchestrator described with circuit breakers and 6-signal routing? | Returned unrelated factory tickets. | Returned swarm README/orchestrator passages describing circuit breakers, 6-signal routing, DAG execution, and executor bridges. | 0 | 0/3 | 3/3 | Vector |

## Summary

Graph wins: 5/10. Vector wins: 5/10.

Graph traversal surfaced evidence vector RAG missed on all 5 relational queries. The missed vector evidence was live factory execution state: execution IDs, ticket joins, gate decisions, factory-record joins, and explicit absence of cost edges.

Vector RAG outperformed graph traversal on all 5 semantic queries. The graph has no indexed passages for Neo4j GraphRAG prose, LightRAG paper tables, Hermes docs, qdrant-rag MCP documentation, or swarm README content, so it returned low-value factory-task matches.

Observed graph limitation: query wording matters. A query containing `gate` and `co-failed` selects the gate template before the co-failed template. Use unambiguous relational wording or a direct read-only Cypher override when the intended template matters.

Verdict: PASS.
