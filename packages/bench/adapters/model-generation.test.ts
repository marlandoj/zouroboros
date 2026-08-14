import { describe, expect, test } from "bun:test";
import {
  extractProviderUsage,
  effectiveTemperatureForModel,
  generateModelAnswer,
  PROVIDER_MAX_ATTEMPTS,
  reasoningModeForModel,
  resolveModelTransport,
  type FetchLike,
  type ProviderEnvironment,
} from "./model-generation";

const ENV: ProviderEnvironment = {
  OPENAI_API_KEY: "openai-test",
  KIMI_API_KEY: "kimi-test",
  OPENROUTER_API_KEY: "openrouter-test",
  OPENCODE_API_KEY: "opencode-test",
  SYNTHETIC_NEW_API_KEY: "synthetic-test",
  ZO_CLIENT_IDENTITY_TOKEN: "zo-test",
};

function input(model: string) {
  return {
    prompt: "Return one word.",
    model,
    seed: 17,
    temperature: 0,
    maxTokens: 512,
    timeoutMs: 1_000,
  };
}

describe("resolveModelTransport", () => {
  test("resolves each supported model namespace without changing its provider", () => {
    expect(resolveModelTransport("gpt-4o-mini", ENV)).toMatchObject({
      provider: "openai",
      requestedModel: "gpt-4o-mini",
      servingModel: "gpt-4o-mini",
      endpoint: "https://api.openai.com/v1/chat/completions",
      credential: "openai-test",
      protocol: "chat-completions",
    });
    expect(resolveModelTransport("byok:model-id", ENV)).toMatchObject({
      provider: "zo-byok",
      requestedModel: "byok:model-id",
      servingModel: "byok:model-id",
      endpoint: "https://api.zo.computer/zo/ask",
      credential: "zo-test",
      protocol: "zo-ask",
    });
    expect(resolveModelTransport("kimi:kimi-k3", ENV)).toMatchObject({
      provider: "kimi",
      requestedModel: "kimi:kimi-k3",
      servingModel: "kimi-k3",
      endpoint: "https://api.moonshot.ai/v1/chat/completions",
      credential: "kimi-test",
      protocol: "chat-completions",
    });
    expect(resolveModelTransport("or:moonshotai/kimi-k3", ENV)).toMatchObject({
      provider: "openrouter",
      requestedModel: "or:moonshotai/kimi-k3",
      servingModel: "moonshotai/kimi-k3",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      credential: "openrouter-test",
      protocol: "chat-completions",
    });
    expect(resolveModelTransport("hf:zai-org/GLM-5.2", ENV)).toMatchObject({
      provider: "synthetic",
      requestedModel: "hf:zai-org/GLM-5.2",
      servingModel: "hf:zai-org/GLM-5.2",
      endpoint: "https://api.synthetic.new/openai/v1/chat/completions",
      credential: "synthetic-test",
      protocol: "chat-completions",
    });
    expect(resolveModelTransport("oc:minimax-m3", ENV)).toMatchObject({
      provider: "opencode",
      requestedModel: "oc:minimax-m3",
      servingModel: "minimax-m3",
      endpoint: "https://opencode.ai/zen/v1/chat/completions",
      credential: "opencode-test",
      protocol: "chat-completions",
    });
    for (const servingModel of [
      "x-ai/grok-4.5",
      "z-ai/glm-5.2",
      "qwen/qwen3.6-27b",
      "nvidia/nemotron-3-super-120b-a12b",
    ]) {
      expect(resolveModelTransport(`or:${servingModel}`, ENV)).toMatchObject({
        provider: "openrouter",
        requestedModel: `or:${servingModel}`,
        servingModel,
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        credential: "openrouter-test",
        protocol: "chat-completions",
      });
    }
    for (const model of [
      "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
      "byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e",
    ]) {
      expect(resolveModelTransport(model, ENV)).toMatchObject({
        provider: "zo-byok",
        requestedModel: model,
        servingModel: model,
        endpoint: "https://api.zo.computer/zo/ask",
        credential: "zo-test",
        protocol: "zo-ask",
      });
    }
  });

  test("direct Kimi fails closed without KIMI_API_KEY and never uses OpenRouter", () => {
    expect(() => resolveModelTransport("kimi:kimi-k3", {
      OPENROUTER_API_KEY: "must-not-fallback",
    })).toThrow("KIMI_API_KEY not set");
  });

  test("rejects empty prefixed model ids", () => {
    expect(() => resolveModelTransport("kimi:", ENV)).toThrow("must not be empty");
    expect(() => resolveModelTransport("or:", ENV)).toThrow("must not be empty");
    expect(() => resolveModelTransport("oc:", ENV)).toThrow("must not be empty");
  });
});

describe("generateModelAnswer", () => {
  test("sends the normalized Kimi model and captures exact provider usage", async () => {
    let url = "";
    let authorization = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (requestUrl: string | URL | Request, init?: RequestInit) => {
      url = requestUrl.toString();
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;

    const result = await generateModelAnswer(input("kimi:kimi-k3"), { env: ENV, fetchImpl });
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(authorization).toBe("Bearer kimi-test");
    expect(body).toMatchObject({
      model: "kimi-k3",
      messages: [{ role: "user", content: "Return one word." }],
      temperature: 0.6,
      max_tokens: 512,
      thinking: { type: "disabled" },
      seed: 17,
    });
    expect(result).toMatchObject({
      text: "answer",
      finishReason: "stop",
      usage: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 },
      provider: "kimi",
      requestedModel: "kimi:kimi-k3",
      servingModel: "kimi-k3",
    });
  });

  test("uses OpenRouter's non-reasoning Kimi K3 request contract", async () => {
    let url = "";
    let authorization = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (requestUrl: string | URL | Request, init?: RequestInit) => {
      url = requestUrl.toString();
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;

    const result = await generateModelAnswer(input("or:moonshotai/kimi-k3"), { env: ENV, fetchImpl });
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authorization).toBe("Bearer openrouter-test");
    expect(body).toMatchObject({
      model: "moonshotai/kimi-k3",
      temperature: 0.6,
      max_tokens: 512,
      reasoning: { effort: "none" },
      seed: 17,
    });
    expect(body).not.toHaveProperty("thinking");
    expect(result).toMatchObject({
      text: "answer",
      provider: "openrouter",
      requestedModel: "or:moonshotai/kimi-k3",
      servingModel: "moonshotai/kimi-k3",
    });
  });

  test("preserves Synthetic and OpenCode route identity and headers", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (requestUrl: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: requestUrl.toString(),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;

    const synthetic = await generateModelAnswer(input("hf:zai-org/GLM-5.2"), { env: ENV, fetchImpl });
    const opencode = await generateModelAnswer(input("oc:minimax-m3"), { env: ENV, fetchImpl });

    expect(requests[0]).toMatchObject({
      url: "https://api.synthetic.new/openai/v1/chat/completions",
      body: { model: "hf:zai-org/GLM-5.2" },
    });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer synthetic-test");
    expect(requests[1]).toMatchObject({
      url: "https://opencode.ai/zen/v1/chat/completions",
      body: { model: "minimax-m3" },
    });
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer opencode-test");
    expect(requests[1]!.headers.get("user-agent")).toContain("Mozilla/5.0");
    expect(synthetic).toMatchObject({ provider: "synthetic", requestedModel: "hf:zai-org/GLM-5.2" });
    expect(opencode).toMatchObject({ provider: "opencode", requestedModel: "oc:minimax-m3" });
  });

  test("disables optional default-on reasoning only for the exact frontier model ids", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;

    for (const model of [
      "or:z-ai/glm-5.2",
      "or:qwen/qwen3.6-27b",
      "or:nvidia/nemotron-3-super-120b-a12b",
      "or:x-ai/grok-4.5",
    ]) {
      await generateModelAnswer(input(model), { env: ENV, fetchImpl });
    }

    expect(bodies.slice(0, 3).every((body) => (
      JSON.stringify(body.reasoning) === JSON.stringify({ enabled: false })
    ))).toBe(true);
    expect(bodies[3]).not.toHaveProperty("reasoning");
  });

  test("retries transient Kimi rate limits without changing provider or model", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const delays: number[] = [];
    const fetchImpl = (async (requestUrl: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: requestUrl.toString(),
        body: JSON.parse(String(init?.body)),
      });
      if (requests.length < PROVIDER_MAX_ATTEMPTS) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;

    const result = await generateModelAnswer(input("kimi:kimi-k3"), {
      env: ENV,
      fetchImpl,
      sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(requests).toHaveLength(PROVIDER_MAX_ATTEMPTS);
    expect(requests.every((request) => request.url === "https://api.moonshot.ai/v1/chat/completions")).toBe(true);
    expect(requests.every((request) => request.body.model === "kimi-k3")).toBe(true);
    expect(delays).toEqual([60_000, 60_000, 60_000]);
    expect(result).toMatchObject({
      text: "recovered",
      provider: "kimi",
      requestedModel: "kimi:kimi-k3",
      servingModel: "kimi-k3",
      usage: { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24 },
    });
  });

  test("preserves the Zo BYOK request contract", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output: "byok answer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as FetchLike;
    const result = await generateModelAnswer(input("byok:model-id"), { env: ENV, fetchImpl });
    expect(body).toEqual({ input: "Return one word.", model_name: "byok:model-id" });
    expect(result).toMatchObject({ text: "byok answer", provider: "zo-byok", servingModel: "byok:model-id" });
  });

  test("retries invalid JSON and empty successful responses on the same route", async () => {
    const delays: number[] = [];
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (requests === 1) {
        return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (requests === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { content: " " } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as FetchLike;

    const result = await generateModelAnswer(input("hf:zai-org/GLM-5.2"), {
      env: ENV,
      fetchImpl,
      sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(requests).toBe(3);
    expect(delays).toEqual([1_000, 3_000]);
    expect(result).toMatchObject({
      text: "recovered",
      provider: "synthetic",
      requestedModel: "hf:zai-org/GLM-5.2",
    });
  });

  test("accepts reasoning-only output with the same precedence as Consensus Gate", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{
        message: { content: "", reasoning_content: "reasoned answer" },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as FetchLike;

    const result = await generateModelAnswer(input("hf:zai-org/GLM-5.2"), { env: ENV, fetchImpl });
    expect(result).toMatchObject({
      text: "reasoned answer",
      provider: "synthetic",
      requestedModel: "hf:zai-org/GLM-5.2",
    });
  });

  test("fails closed on provider errors and empty answers without exposing credentials", async () => {
    const failedFetch = (async () => new Response("upstream rejected kimi-test", { status: 401 })) as FetchLike;
    await expect(generateModelAnswer(input("kimi:kimi-k3"), { env: ENV, fetchImpl: failedFetch }))
      .rejects.toThrow("kimi request failed with HTTP 401");
    try {
      await generateModelAnswer(input("kimi:kimi-k3"), { env: ENV, fetchImpl: failedFetch });
    } catch (error) {
      expect(String(error)).not.toContain("kimi-test");
    }

    const emptyFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "   " }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as FetchLike;
    await expect(generateModelAnswer(input("kimi:kimi-k3"), {
      env: ENV,
      fetchImpl: emptyFetch,
      sleepImpl: async () => {},
    }))
      .rejects.toThrow("kimi returned an empty answer");
  });
});

describe("extractProviderUsage", () => {
  test("accepts exact provider counters and derives total only when omitted", () => {
    expect(extractProviderUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }))
      .toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(extractProviderUsage({ prompt_tokens: 10, completion_tokens: 4 }))
      .toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(extractProviderUsage({ prompt_tokens: 10 })).toBeUndefined();
  });
});

test("normalizes only exact Kimi K3 request controls to provider-required values", () => {
  expect(effectiveTemperatureForModel("kimi:kimi-k3", 0)).toBe(0.6);
  expect(effectiveTemperatureForModel("or:moonshotai/kimi-k3", 0.1)).toBe(0.6);
  expect(effectiveTemperatureForModel("gpt-4o-mini", 0)).toBe(0);
  expect(reasoningModeForModel("kimi:kimi-k3")).toBe("disabled");
  expect(reasoningModeForModel("or:moonshotai/kimi-k3")).toBe("disabled");
  expect(reasoningModeForModel("or:z-ai/glm-5.2")).toBe("disabled");
  expect(reasoningModeForModel("or:qwen/qwen3.6-27b")).toBe("disabled");
  expect(reasoningModeForModel("or:nvidia/nemotron-3-super-120b-a12b")).toBe("disabled");
  expect(reasoningModeForModel("or:x-ai/grok-4.5")).toBe("provider-default");
  expect(reasoningModeForModel("gpt-4o-mini")).toBe("provider-default");
});
