import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extractBearer, tokenMatches } from "../auth";
import type { ShadowCoordinator } from "./coordinator";

export interface ControlPlaneApiOptions {
  authToken: string;
  host: string;
  port: number;
}

export interface ControlPlaneApiHandle {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number };
}

const MAX_BODY_BYTES = 64 * 1024;

export function createControlPlaneApi(
  coordinator: ShadowCoordinator,
  options: ControlPlaneApiOptions,
): ControlPlaneApiHandle {
  if (!options.authToken) throw new Error("control-plane auth token is required");
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { status: "ok", mode: "shadow" });
      }
      if (!authorized(req, options.authToken)) return sendJson(res, 401, { error: "unauthorized" });

      if (method === "POST" && url.pathname === "/v1/jobs") {
        const result = coordinator.submit(await readJson(req));
        return sendJson(res, result.deduplicated ? 200 : 201, result);
      }
      if (method === "GET" && url.pathname === "/v1/jobs") {
        return sendJson(res, 200, { jobs: coordinator.list() });
      }
      if (method === "POST" && url.pathname === "/v1/reconcile") {
        return sendJson(res, 200, coordinator.reconcile());
      }
      if (method === "POST" && url.pathname === "/v1/tick") {
        return sendJson(res, 200, await coordinator.tick());
      }

      const jobRoute = /^\/v1\/jobs\/(job-[a-zA-Z0-9-]+)$/.exec(url.pathname);
      if (method === "GET" && jobRoute) {
        const job = coordinator.get(jobRoute[1]);
        return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: "not found" });
      }
      const cancelRoute = /^\/v1\/jobs\/(job-[a-zA-Z0-9-]+)\/cancel$/.exec(url.pathname);
      if (method === "POST" && cancelRoute) {
        const job = coordinator.cancel(cancelRoute[1]);
        return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: "not found" });
      }
      const heartbeatRoute = /^\/v1\/jobs\/(job-[a-zA-Z0-9-]+)\/heartbeat$/.exec(url.pathname);
      if (method === "POST" && heartbeatRoute) {
        const body = await readJson(req);
        const leaseId = isRecord(body) && typeof body.lease_id === "string" ? body.lease_id : "";
        if (!leaseId) return sendJson(res, 400, { error: "lease_id is required" });
        const job = coordinator.renew(heartbeatRoute[1], leaseId);
        return job ? sendJson(res, 200, { job }) : sendJson(res, 409, { error: "lease mismatch or job not leased" });
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("body") || message.includes("field") || message.includes("must") || message.includes("unsupported")
        ? 400
        : 500;
      return sendJson(res, status, { error: status === 400 ? message : "internal error" });
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    address: () => {
      const address = server.address();
      if (!address || typeof address === "string") return { host: options.host, port: options.port };
      return { host: options.host, port: address.port };
    },
  };
}

function authorized(req: IncomingMessage, expected: string): boolean {
  const presented = extractBearer(req.headers.authorization);
  return presented !== null && tokenMatches(presented, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body exceeds 65536 bytes"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
