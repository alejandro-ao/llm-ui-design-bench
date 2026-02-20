export type ProviderId = "huggingface" | "openai" | "anthropic" | "google";

export interface ProviderOption {
  id: ProviderId;
  label: string;
}

export interface ProviderModelPreset {
  modelId: string;
  label: string;
  vendor: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "huggingface",
    label: "Hugging Face",
  },
  {
    id: "openai",
    label: "OpenAI",
  },
  {
    id: "anthropic",
    label: "Anthropic",
  },
  {
    id: "google",
    label: "Google",
  },
];

export const OPENAI_MODEL_PRESETS: ProviderModelPreset[] = [
  {
    modelId: "gpt-5.1",
    label: "GPT-5.1",
    vendor: "openai",
  },
  {
    modelId: "gpt-5.2",
    label: "GPT-5.2",
    vendor: "openai",
  },
  {
    modelId: "gpt-5-mini",
    label: "GPT-5 mini",
    vendor: "openai",
  },
  {
    modelId: "gpt-5-nano",
    label: "GPT-5 nano",
    vendor: "openai",
  },
  {
    modelId: "gpt-4.1",
    label: "GPT-4.1",
    vendor: "openai",
  },
];

export const ANTHROPIC_MODEL_PRESETS: ProviderModelPreset[] = [
  {
    modelId: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    vendor: "anthropic",
  },
  {
    modelId: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    vendor: "anthropic",
  },
  {
    modelId: "claude-opus-4-1-20250805",
    label: "Claude Opus 4.1",
    vendor: "anthropic",
  },
  {
    modelId: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4",
    vendor: "anthropic",
  },
  {
    modelId: "claude-3-5-haiku-latest",
    label: "Claude 3.5 Haiku",
    vendor: "anthropic",
  },
];

export const GOOGLE_MODEL_PRESETS: ProviderModelPreset[] = [
  {
    modelId: "gemini-3-pro-preview",
    label: "Gemini 3 Pro (Preview)",
    vendor: "google",
  },
  {
    modelId: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (Preview)",
    vendor: "google",
  },
  {
    modelId: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    vendor: "google",
  },
];

export const PROVIDER_MODEL_PRESETS: Record<Exclude<ProviderId, "huggingface">, ProviderModelPreset[]> = {
  openai: OPENAI_MODEL_PRESETS,
  anthropic: ANTHROPIC_MODEL_PRESETS,
  google: GOOGLE_MODEL_PRESETS,
};

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_OPTIONS.some((option) => option.id === value);
}

export function getProviderLabel(provider: ProviderId): string {
  const option = PROVIDER_OPTIONS.find((value) => value.id === provider);
  return option?.label ?? provider;
}
