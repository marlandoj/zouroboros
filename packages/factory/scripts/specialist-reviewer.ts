export interface SpecialistModelIdentity {
  modelName: string;
  vendor: string;
}

export interface SpecialistReviewerPolicy {
  candidates: SpecialistModelIdentity[];
  requireDistinctModel?: boolean;
  requireVendorDiversity?: boolean;
}

export interface SpecialistReviewerSelection extends SpecialistModelIdentity {
  implementerModelName: string;
  implementerVendor: string;
  distinctModel: boolean;
  vendorDiverse: boolean;
}

export const DEFAULT_SPECIALIST_REVIEWER_MODELS: SpecialistModelIdentity[] = [
  { modelName: "byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0", vendor: "anthropic" },
  { modelName: "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f", vendor: "openai" },
];

const KNOWN_MODEL_VENDORS = new Map<string, string>([
  ["byok:461d8d6f-9616-4391-960e-3caea2a27829", "anthropic"],
  ["byok:63a73cf2-224a-4641-8dcb-c3313270d08a", "anthropic"],
  ["byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0", "anthropic"],
  ["byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e", "anthropic"],
  ["byok:2d297290-05e1-4f64-848c-0356e74f7187", "openai"],
  ["byok:fcb940f0-9ff7-42b2-9f04-ca8460a314a5", "openai"],
  ["byok:47466410-d8ac-4c24-ab32-b5be5c2be6cd", "openai"],
  ["byok:905b6491-3b7f-4ed6-864c-a9817603cb0f", "openai"],
  ["byok:bc8717e3-e94f-416e-81d5-ab9d80962766", "openai"],
  ["byok:ef1faca8-a70d-46d3-88d3-b78f96635885", "openai"],
  ["byok:463350ac-4a49-4ceb-8653-042ecffa513f", "moonshot"],
  ["byok:73ae74c2-26d1-561e-91af-2cf47a33f4dd", "moonshot"],
  ["byok:76aef0ac-9f7e-50fc-9f13-c8332a118662", "moonshot"],
  ["byok:d1f6a676-f46f-5f70-8991-baeec4df3bc6", "moonshot"],
  ["byok:bb3d131d-749f-423b-a285-9f9efd103926", "z-ai"],
]);

export function resolveModelVendor(modelName: string, explicitVendor?: string): string | null {
  const explicit = explicitVendor?.trim().toLowerCase();
  if (explicit) return explicit;
  const known = KNOWN_MODEL_VENDORS.get(modelName.trim());
  if (known) return known;
  const lower = modelName.toLowerCase();
  if (/anthropic|claude/.test(lower)) return "anthropic";
  if (/openai|gpt|codex/.test(lower)) return "openai";
  if (/moonshot|kimi/.test(lower)) return "moonshot";
  if (/z-ai|zai|glm/.test(lower)) return "z-ai";
  if (/google|gemini/.test(lower)) return "google";
  if (/deepseek/.test(lower)) return "deepseek";
  return null;
}

export function selectIndependentReviewerModel(input: {
  implementerModelName: string;
  implementerVendor?: string;
  policy?: SpecialistReviewerPolicy;
}): SpecialistReviewerSelection {
  const implementerModelName = input.implementerModelName.trim();
  if (!implementerModelName) throw new Error("implementer model is required for specialist review enforcement");
  const policy = input.policy ?? { candidates: DEFAULT_SPECIALIST_REVIEWER_MODELS };
  const requireDistinctModel = policy.requireDistinctModel ?? true;
  const requireVendorDiversity = policy.requireVendorDiversity ?? true;
  const implementerVendor = resolveModelVendor(implementerModelName, input.implementerVendor);
  if (requireVendorDiversity && !implementerVendor) {
    throw new Error(`implementer vendor is unresolved for ${implementerModelName}`);
  }
  for (const candidate of policy.candidates) {
    const modelName = candidate.modelName.trim();
    const vendor = resolveModelVendor(modelName, candidate.vendor);
    if (!modelName || !vendor) continue;
    const distinctModel = modelName !== implementerModelName;
    const vendorDiverse = implementerVendor ? vendor !== implementerVendor : false;
    if (requireDistinctModel && !distinctModel) continue;
    if (requireVendorDiversity && !vendorDiverse) continue;
    return {
      modelName,
      vendor,
      implementerModelName,
      implementerVendor: implementerVendor ?? "unknown",
      distinctModel,
      vendorDiverse,
    };
  }
  throw new Error(
    `no specialist reviewer model satisfies distinct-model=${requireDistinctModel} vendor-diversity=${requireVendorDiversity} for ${implementerModelName}`,
  );
}
