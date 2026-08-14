import type { UsageV2 } from "../contracts/result-contract";

export type ModelProvider = "openai" | "zo-byok" | "kimi" | "openrouter" | "opencode" | "synthetic";

export interface ProviderEnvironment {
  [key: string]: string | undefined;
  OPENAI_API_KEY?: string;
  KIMI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  SYNTHETIC_NEW_API_KEY?: string;
  ZO_TOKEN?: string;
  ZO_CLIENT_IDENTITY_TOKEN?: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ResolvedModelTransport {
  provider: ModelProvider;
  requestedModel: string;
  servingModel: string;
  endpoint: string;
  credential: string;
  protocol: "chat-completions" | "zo-ask";
  headers?: Record<string, string>;
}

export interface GenResult {
  text: string;
  finishReason?: string;
  timedOut?: boolean;
  usage?: UsageV2;
  provider: ModelProvider;
  requestedModel: string;
  servingModel: string;
}

export interface GenerateModelInput {
  prompt: string;
  model: string;
  seed?: number;
  temperature?: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface GenerateModelDependencies {
  env?: ProviderEnvironment;
  fetchImpl?: FetchLike;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

export const PROVIDER_MAX_ATTEMPTS = 4;
const PROVIDER_RETRY_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60_000;
const OPENROUTER_OPTIONAL_REASONING_MODELS = new Set([
  "or:z-ai/glm-5.2",
  "or:qwen/qwen3.6-27b",
  "or:nvidia/nemotron-3-super-120b-a12b",
]);

function firstNonEmptyText(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) as string | undefined;
}

function isRetriableProviderStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function providerRetryDelayMs(response: Response, failedAttempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }
  if (response.status === 429) return RATE_LIMIT_COOLDOWN_MS;
  return PROVIDER_RETRY_BACKOFF_MS[Math.min(failedAttempt - 1, PROVIDER_RETRY_BACKOFF_MS.length - 1)];
}

function requiredCredential(value: string | undefined, name: string): string {
  const credential = value?.trim();
  if (!credential) throw new Error(`${name} not set`);
  return credential;
}

function prefixedModel(requestedModel: string, prefix: string): string {
  const servingModel = requestedModel.slice(prefix.length).trim();
  if (!servingModel) throw new Error(`model id after ${prefix} must not be empty`);
  return servingModel;
}

export function resolveModelTransport(
  requestedModel: string,
  env: ProviderEnvironment = process.env,
): ResolvedModelTransport {
  if (requestedModel.startsWith("byok:")) {
    return {
      provider: "zo-byok",
      requestedModel,
      servingModel: requestedModel,
      endpoint: "https://api.zo.computer/zo/ask",
      credential: requiredCredential(env.ZO_TOKEN || env.ZO_CLIENT_IDENTITY_TOKEN, "ZO_TOKEN / ZO_CLIENT_IDENTITY_TOKEN"),
      protocol: "zo-ask",
    };
  }

  if (requestedModel.startsWith("kimi:")) {
    return {
      provider: "kimi",
      requestedModel,
      servingModel: prefixedModel(requestedModel, "kimi:"),
      endpoint: "https://api.moonshot.ai/v1/chat/completions",
      credential: requiredCredential(env.KIMI_API_KEY, "KIMI_API_KEY"),
      protocol: "chat-completions",
    };
  }

  if (requestedModel.startsWith("hf:") || requestedModel.startsWith("syn:")) {
    return {
      provider: "synthetic",
      requestedModel,
      servingModel: requestedModel.replace(/^syn:/, "hf:"),
      endpoint: "https://api.synthetic.new/openai/v1/chat/completions",
      credential: requiredCredential(env.SYNTHETIC_NEW_API_KEY, "SYNTHETIC_NEW_API_KEY"),
      protocol: "chat-completions",
    };
  }

  if (requestedModel.startsWith("oc:")) {
    return {
      provider: "opencode",
      requestedModel,
      servingModel: prefixedModel(requestedModel, "oc:"),
      endpoint: "https://opencode.ai/zen/v1/chat/completions",
      credential: requiredCredential(env.OPENCODE_API_KEY, "OPENCODE_API_KEY"),
      protocol: "chat-completions",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    };
  }

  if (requestedModel.startsWith("or:")) {
    return {
      provider: "openrouter",
      requestedModel,
      servingModel: prefixedModel(requestedModel, "or:"),
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      credential: requiredCredential(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
      protocol: "chat-completions",
    };
  }

  return {
    provider: "openai",
    requestedModel,
    servingModel: requestedModel,
    endpoint: "https://api.openai.com/v1/chat/completions",
    credential: requiredCredential(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    protocol: "chat-completions",
  };
}

export function effectiveTemperatureForModel(requestedModel: string, requestedTemperature: number): number {
  if (requestedModel === "kimi:kimi-k3" || requestedModel === "or:moonshotai/kimi-k3") return 0.6;
  return requestedTemperature;
}

export function reasoningModeForModel(requestedModel: string): "disabled" | "provider-default" {
  if (
    requestedModel === "kimi:kimi-k3"
    || requestedModel === "or:moonshotai/kimi-k3"
    || OPENROUTER_OPTIONAL_REASONING_MODELS.has(requestedModel)
  ) return "disabled";
  return "provider-default";
}

function chatCompletionOverrides(transport: ResolvedModelTransport): Record<string, unknown> {
  if (transport.provider === "kimi" && transport.servingModel === "kimi-k3") {
    return { thinking: { type: "disabled" } };
  }
  if (transport.provider === "openrouter" && transport.servingModel === "moonshotai/kimi-k3") {
    return { reasoning: { effort: "none" } };
  }
  if (transport.provider === "openrouter" && OPENROUTER_OPTIONAL_REASONING_MODELS.has(transport.requestedModel)) {
    return { reasoning: { enabled: false } };
  }
  return {};
}

export function extractProviderUsage(raw: unknown): UsageV2 | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const prompt = typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)
    ? usage.prompt_tokens
    : null;
  const completion = typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens)
    ? usage.completion_tokens
    : null;
  if (prompt === null || completion === null) return undefined;
  const total = typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export async function generateModelAnswer(
  input: GenerateModelInput,
  dependencies: GenerateModelDependencies = {},
): Promise<GenResult> {
  const transport = resolveModelTransport(input.model, dependencies.env ?? process.env);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleepImpl = dependencies.sleepImpl ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const controller = input.timeoutMs > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined;

  try {
    const body = transport.protocol === "zo-ask"
      ? { input: input.prompt, model_name: transport.servingModel }
      : {
          model: transport.servingModel,
          messages: [{ role: "user", content: input.prompt }],
          temperature: effectiveTemperatureForModel(
            transport.requestedModel,
            input.temperature ?? 0.1,
          ),
          max_tokens: input.maxTokens,
          ...chatCompletionOverrides(transport),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        };
    const authorization = transport.protocol === "zo-ask"
      ? transport.credential
      : `Bearer ${transport.credential}`;
    let data: {
      output?: unknown;
      choices?: Array<{
        message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: unknown;
    } | undefined;
    for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt++) {
      const response = await fetchImpl(transport.endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          ...transport.headers,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (!response.ok) {
        if (!isRetriableProviderStatus(response.status) || attempt === PROVIDER_MAX_ATTEMPTS) {
          throw new Error(`${transport.provider} request failed with HTTP ${response.status}`);
        }
        await sleepImpl(providerRetryDelayMs(response, attempt));
        continue;
      }

      let candidate: typeof data;
      try {
        candidate = await response.json() as typeof data;
      } catch {
        if (attempt === PROVIDER_MAX_ATTEMPTS) {
          throw new Error(`${transport.provider} returned invalid JSON`);
        }
        await sleepImpl(PROVIDER_RETRY_BACKOFF_MS[Math.min(attempt - 1, PROVIDER_RETRY_BACKOFF_MS.length - 1)]);
        continue;
      }
      const candidateMessage = candidate?.choices?.[0]?.message;
      const candidateText = transport.protocol === "zo-ask"
        ? firstNonEmptyText(candidate?.output)
        : firstNonEmptyText(candidateMessage?.content, candidateMessage?.reasoning_content, candidateMessage?.reasoning);
      if (!candidateText) {
        if (attempt === PROVIDER_MAX_ATTEMPTS) {
          throw new Error(`${transport.provider} returned an empty answer`);
        }
        await sleepImpl(PROVIDER_RETRY_BACKOFF_MS[Math.min(attempt - 1, PROVIDER_RETRY_BACKOFF_MS.length - 1)]);
        continue;
      }
      data = candidate;
      break;
    }
    if (!data) throw new Error(`${transport.provider} request failed without a usable response`);

    const message = data.choices?.[0]?.message;
    const text = (transport.protocol === "zo-ask"
      ? firstNonEmptyText(data.output)
      : firstNonEmptyText(message?.content, message?.reasoning_content, message?.reasoning))!.trim();
    const finishReason = transport.protocol === "chat-completions"
      && typeof data.choices?.[0]?.finish_reason === "string"
      ? data.choices[0].finish_reason
      : undefined;

    return {
      text,
      finishReason,
      usage: extractProviderUsage(data.usage),
      provider: transport.provider,
      requestedModel: transport.requestedModel,
      servingModel: transport.servingModel,
    };
  } catch (error) {
    if (controller?.signal.aborted) {
      return {
        text: "",
        timedOut: true,
        provider: transport.provider,
        requestedModel: transport.requestedModel,
        servingModel: transport.servingModel,
      };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
