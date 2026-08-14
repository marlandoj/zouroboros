#!/usr/bin/env bun
const COLLECTION = "all-out-gamedev";
const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(QDRANT_KEY ? { "api-key": QDRANT_KEY } : {}),
  };
}

async function qdrant(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Qdrant ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: bun check-corpus.ts");
    return;
  }
  const info = (await qdrant("GET", `/collections/${COLLECTION}`)).result;
  const scrolled = await qdrant("POST", `/collections/${COLLECTION}/points/scroll`, {
    limit: Math.max(500, info.points_count || 0),
    with_payload: true,
    with_vector: false,
  });
  const points = scrolled.result?.points || [];
  const urls = new Set(points.map((point: any) => point.payload?.url).filter(Boolean));
  const sourceTypes = new Map<string, Set<string>>();
  const roleCounts = new Map<string, number>();
  for (const point of points) {
    const type = point.payload?.source_type || "unknown";
    if (!sourceTypes.has(type)) sourceTypes.set(type, new Set());
    sourceTypes.get(type)?.add(point.payload?.url);
    for (const role of point.payload?.role_tags || []) roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
  }
  const requiredUrls = [
    "https://docs.allout.game/scripting/syntax.md",
    "https://docs.allout.game/scripting/networking-fundamentals.md",
    "https://docs.allout.game/getting-started/playtesting-your-game.md",
    "https://docs.allout.game/going-all-out/publishing-your-game.md",
    "https://docs.allout.game/going-all-out/improving-performance.md",
    "https://allout.game/terms-of-service",
  ];
  const checks = {
    status_green: info.status === "green",
    point_floor: Number(info.points_count || 0) >= 150,
    official_document_floor: (sourceTypes.get("official_all_out")?.size || 0) >= 60,
    agency_reference_floor: (sourceTypes.get("agency_agents")?.size || 0) >= 5,
    dated_project_baseline_absent: !sourceTypes.has("project_baseline"),
    role_playbooks_present: (sourceTypes.get("internal_playbook")?.size || 0) >= 4,
    required_sources_present: requiredUrls.every((url) => urls.has(url)),
    role_coverage: ["director", "engineer", "art-ux", "qa"].every((role) => (roleCounts.get(role) || 0) > 0),
    named_dense_vector: Boolean(info.config?.params?.vectors?.dense),
    sparse_vector: Boolean(info.config?.params?.sparse_vectors?.sparse),
  };
  const passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    passed,
    collection: COLLECTION,
    points: info.points_count,
    documents: urls.size,
    source_documents: Object.fromEntries([...sourceTypes].map(([key, value]) => [key, value.size])),
    role_chunks: Object.fromEntries(roleCounts),
    checks,
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
