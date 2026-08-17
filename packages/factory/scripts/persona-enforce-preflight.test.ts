import { describe, expect, test } from "bun:test";
import { runPersonaEnforcePreflight } from "./persona-enforce-preflight";

describe("persona enforce preflight", () => {
  test("uses an exact persona identity and a vendor-diverse reviewer model", async () => {
    const calls: Array<{ model_name: string; persona_id: string }> = [];
    const result = await runPersonaEnforcePreflight({
      personaName: "Mobile App Builder",
      implementerModelName: "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
      timeoutMs: 5_000,
    }, {
      listPersonas: async () => [
        "id='mobile-id' name='Mobile App Builder' model='byok:persona-default' scopes=['all'] updated_at=None",
      ],
      invokePersona: async (request) => {
        calls.push({ model_name: request.model_name, persona_id: request.persona_id });
        return { output: "AUTH_OK", model_name: request.model_name, cost_usd: 0 };
      },
    });
    expect(calls).toEqual([{
      model_name: "byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0",
      persona_id: "mobile-id",
    }]);
    expect(result).toMatchObject({
      ok: true,
      persona_name: "Mobile App Builder",
      implementer_vendor: "openai",
      requested_reviewer_vendor: "anthropic",
      distinct_model: true,
      vendor_diverse: true,
    });
  });

  test("fails closed when the adviser does not return the exact acknowledgement", async () => {
    await expect(runPersonaEnforcePreflight({
      personaName: "Mobile App Builder",
      implementerModelName: "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
      timeoutMs: 5_000,
    }, {
      listPersonas: async () => [
        "id='mobile-id' name='Mobile App Builder' model='byok:persona-default' scopes=['all'] updated_at=None",
      ],
      invokePersona: async (request) => ({
        output: "The endpoint is reachable.",
        model_name: request.model_name,
        cost_usd: 0,
      }),
    })).rejects.toThrow("exact AUTH_OK");
  });
});
