export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  vendor: string;
  enabled: boolean;
}

export const CURATED_MODELS: ModelConfig[] = [
  {
    id: "kimi-k2-instruct",
    name: "Kimi K2 Instruct",
    provider: "huggingface",
    vendor: "moonshotai",
    enabled: true,
  },
  {
    id: "minimax-m1",
    name: "MiniMax M1",
    provider: "huggingface",
    vendor: "minimax",
    enabled: true,
  },
  {
    id: "qwen3-coder",
    name: "Qwen 3 Coder",
    provider: "huggingface",
    vendor: "qwen",
    enabled: true,
  },
  {
    id: "deepseek-r1",
    name: "DeepSeek R1",
    provider: "huggingface",
    vendor: "deepseek",
    enabled: true,
  },
];

const MODEL_LOOKUP = new Map(CURATED_MODELS.map((model) => [model.id, model]));

export function getModelConfig(modelId: string): ModelConfig | null {
  return MODEL_LOOKUP.get(modelId) ?? null;
}

export function inferVendorFromModelId(modelId: string): string {
  const configured = getModelConfig(modelId);
  if (configured) {
    return configured.vendor;
  }

  const trimmed = modelId.trim();
  if (!trimmed) {
    return "unknown";
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    return trimmed.slice(0, slashIndex).toLowerCase();
  }

  const dashIndex = trimmed.indexOf("-");
  if (dashIndex > 0) {
    return trimmed.slice(0, dashIndex).toLowerCase();
  }

  return "unknown";
}
