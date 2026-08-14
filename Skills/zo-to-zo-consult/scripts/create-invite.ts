import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Args {
  alaricPersonaId: string;
  outClient: string;
  outEnv: string;
  endpoint?: string;
  expiresHours: number;
  activeHours: number;
  maxTurns: number;
}

function help(): string {
  return [
    "Usage:",
    "  bun create-invite.ts --alaric-persona-id <id> --out-client <path> --out-env <path>",
    "",
    "Options:",
    "  --endpoint <url>          Broker endpoint; may be finalized later",
    "  --expires-hours <n>       Invitation lifetime; default 168",
    "  --active-hours <n>        Session lifetime after first use; default 2",
    "  --max-turns <n>           Broker turn limit; default 8",
  ].join("\n");
}

function positiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(name + " must be positive");
  return parsed;
}

function parseArgs(argv: string[]): Args {
  let alaricPersonaId = "";
  let outClient = "";
  let outEnv = "";
  let endpoint: string | undefined;
  let expiresHours = 168;
  let activeHours = 2;
  let maxTurns = 8;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(help());
      process.exit(0);
    }
    if (arg === "--alaric-persona-id") alaricPersonaId = argv[++index] || "";
    else if (arg === "--out-client") outClient = argv[++index] || "";
    else if (arg === "--out-env") outEnv = argv[++index] || "";
    else if (arg === "--endpoint") endpoint = argv[++index] || "";
    else if (arg === "--expires-hours") {
      expiresHours = positiveNumber(arg, argv[++index], expiresHours);
    } else if (arg === "--active-hours") {
      activeHours = positiveNumber(arg, argv[++index], activeHours);
    } else if (arg === "--max-turns") {
      maxTurns = positiveNumber(arg, argv[++index], maxTurns);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  if (!alaricPersonaId) throw new Error("--alaric-persona-id is required");
  if (!outClient) throw new Error("--out-client is required");
  if (!outEnv) throw new Error("--out-env is required");
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) {
    throw new Error("--max-turns must be an integer from 1 to 32");
  }
  if (endpoint && !/^https:\/\//.test(endpoint)) {
    throw new Error("--endpoint must use HTTPS");
  }

  return {
    alaricPersonaId,
    outClient: resolve(outClient),
    outEnv: resolve(outEnv),
    endpoint,
    expiresHours,
    activeHours,
    maxTurns,
  };
}

function replaceOnce(source: string, marker: string, value: string): string {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error("Template marker not found: " + marker);
  if (source.indexOf(marker, index + marker.length) >= 0) {
    throw new Error("Template marker appears more than once: " + marker);
  }
  return source.slice(0, index) + value + source.slice(index + marker.length);
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2));
  const token = randomBytes(32).toString("base64url");
  const sessionId = "z2z-" + new Date().toISOString().slice(0, 10) + "-" + randomBytes(6).toString("hex");
  const expiresAt = new Date(Date.now() + args.expiresHours * 60 * 60_000).toISOString();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const templatePath = resolve(import.meta.dir, "phyre-client.template.ts");
  let client = readFileSync(templatePath, "utf8");
  client = replaceOnce(
    client,
    "__BROKER_URL__",
    JSON.stringify(args.endpoint || "__BROKER_URL_PENDING__"),
  );
  client = replaceOnce(client, "__INVITE_TOKEN__", JSON.stringify(token));
  client = replaceOnce(client, "__SESSION_ID__", JSON.stringify(sessionId));

  const environment = {
    CONSULT_TOKEN_SHA256: tokenHash,
    CONSULT_SESSION_ID: sessionId,
    CONSULT_INVITE_EXPIRES_AT: expiresAt,
    CONSULT_ACTIVE_HOURS: String(args.activeHours),
    CONSULT_MAX_TURNS: String(args.maxTurns),
    ALARIC_PERSONA_ID: args.alaricPersonaId,
    CONSULT_RUNTIME_DIR: "/home/workspace/.zo/consult-sessions",
  };

  mkdirSync(dirname(args.outClient), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(args.outEnv), { recursive: true, mode: 0o700 });
  writeFileSync(args.outClient, client, { mode: 0o600 });
  writeFileSync(args.outEnv, JSON.stringify(environment, null, 2) + "\n", { mode: 0o600 });
  chmodSync(args.outClient, 0o600);
  chmodSync(args.outEnv, 0o600);

  console.log(
    JSON.stringify(
      {
        created: true,
        session_id: sessionId,
        expires_at: expiresAt,
        active_hours: args.activeHours,
        max_turns: args.maxTurns,
        client_file: args.outClient,
        broker_env_file: args.outEnv,
        token_printed: false,
      },
      null,
      2,
    ),
  );
}

main();
