export type Config = Record<string, unknown>;
export function mergeProviderConfig(base: Config, override: Config): Config { return { ...base, ...override }; }
