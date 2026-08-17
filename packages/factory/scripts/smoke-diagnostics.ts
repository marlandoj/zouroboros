const BUN_SUMMARY_LINE = /^(?:Ran \d+ tests? across|\d+ (?:pass|fail)|\d+ expect\(\) calls)/;
const ACTIONABLE_FAILURE = /^(?:error:|ENOENT:|E[A-Z]+:)|Cannot find module|timed? ?out/i;

export function bunTestFailureDetail(code: number, out: string, err: string): string {
  const lines = `${err}\n${out}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionableIndex = lines.findIndex((line) => ACTIONABLE_FAILURE.test(line));
  if (actionableIndex >= 0) {
    return lines
      .slice(actionableIndex, actionableIndex + 4)
      .filter((line) => !BUN_SUMMARY_LINE.test(line))
      .slice(0, 3)
      .join(" | ")
      .slice(0, 600);
  }
  const failedTest = lines.find((line) => line.startsWith("(fail)"));
  if (failedTest) return failedTest.slice(0, 600);
  const fallback = [...lines].reverse().find((line) => !BUN_SUMMARY_LINE.test(line));
  return fallback?.slice(0, 600) ?? `exit ${code}`;
}

export function hermeticSmokeProbeEnv(
  stateRoot: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    FACTORY_STATE_DIR: stateRoot,
    FACTORY_STATE_MODE: "test",
    FACTORY_STATE_ALLOW_OUTSIDE_ROOT: "1",
  };
}
