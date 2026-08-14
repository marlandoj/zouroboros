const KEYS = ["FAL_KEY", "TRIPO_API_KEY", "ELEVENLABS_API_KEY"] as const;

export function probeCredentials(env: Record<string, string | undefined> = process.env): Record<string, "SET" | "MISSING"> {
  return Object.fromEntries(KEYS.map((key) => [key, env[key]?.trim() ? "SET" : "MISSING"]));
}

if (import.meta.main) {
  const result = probeCredentials();
  for (const key of KEYS) console.log(`${key}=${result[key]}`);
}

