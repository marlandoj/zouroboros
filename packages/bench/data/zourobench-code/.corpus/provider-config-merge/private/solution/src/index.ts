export type Config = Record<string, unknown>;
const blocked = new Set(["__proto__", "prototype", "constructor"]);
function plain(value: unknown): value is Config { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function mergeProviderConfig(base: Config, override: Config): Config {
  const out: Config = {};
  for (const source of [base, override]) {
    for (const [key, value] of Object.entries(source)) {
      if (blocked.has(key)) throw new Error("unsafe configuration key");
      out[key] = plain(value) && plain(out[key]) ? mergeProviderConfig(out[key] as Config, value) : structuredClone(value);
    }
  }
  return out;
}
