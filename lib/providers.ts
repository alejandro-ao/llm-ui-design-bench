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
    modelId: "gpt-4.1",
    label: "GPT-4.1",
    vendor: "openai",
  },
  {
    modelId: "gpt-4o",
    label: "GPT-4o",
    vendor: "openai",
  },
  {
    modelId: "gpt-4o-mini",
    label: "GPT-4o Mini",
    vendor: "openai",
  },
];

export const ANTHROPIC_MODEL_PRESETS: ProviderModelPreset[] = [
  {
    modelId: "claude-3-7-sonnet-latest",
    label: "Claude 3.7 Sonnet",
    vendor: "anthropic",
  },
  {
    modelId: "claude-3-5-sonnet-latest",
    label: "Claude 3.5 Sonnet",
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
    modelId: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    vendor: "google",
  },
  {
    modelId: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    vendor: "google",
  },
  {
    modelId: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
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
