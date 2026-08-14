import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function main(): void {
  const argv = Bun.argv.slice(2);
  const clientIndex = argv.indexOf("--client");
  const endpointIndex = argv.indexOf("--endpoint");
  const client = clientIndex >= 0 ? argv[clientIndex + 1] : "";
  const endpoint = endpointIndex >= 0 ? argv[endpointIndex + 1] : "";
  if (!client || !endpoint) {
    throw new Error("Usage: bun finalize-invite.ts --client <path> --endpoint <https-url>");
  }
  if (!/^https:\/\//.test(endpoint)) throw new Error("--endpoint must use HTTPS");

  const path = resolve(client);
  const source = readFileSync(path, "utf8");
  const marker = "const BROKER_URL: string = \"__BROKER_URL_PENDING__\";";
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error("Expected exactly one pending broker URL declaration");
  }
  const updated = source.replace(
    marker,
    "const BROKER_URL: string = " + JSON.stringify(endpoint) + ";",
  );
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, updated, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  console.log(JSON.stringify({ finalized: true, client_file: path, endpoint, token_printed: false }));
}

main();
