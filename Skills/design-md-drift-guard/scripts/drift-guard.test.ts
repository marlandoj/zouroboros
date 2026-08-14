import { describe, expect, test } from "bun:test";
import { stripExemptScopes } from "./drift-guard";

describe("stripExemptScopes", () => {
  test("removes an exempt scope, its descendants, and dark-mode variants", () => {
    const css = [
      ":root { --brand: #16A36B; }",
      ".pm-trading { --card: #FFFFFF; }",
      ".dark .pm-trading { --card: #111417; }",
      ".pm-trading .pm-badge { color: #D40924; }",
      ".pm-tradingish { color: #F7F6F3; }",
    ].join("\n");

    const stripped = stripExemptScopes(css, [".pm-trading"]);

    expect(stripped).toContain("#16A36B");
    expect(stripped).toContain("#F7F6F3");
    expect(stripped).not.toContain("#FFFFFF");
    expect(stripped).not.toContain("#111417");
    expect(stripped).not.toContain("#D40924");
  });
});
