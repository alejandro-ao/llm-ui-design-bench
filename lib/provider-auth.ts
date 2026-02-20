import type { NextRequest } from "next/server";

import { HfCredentialError, resolveHfApiKeyFromRequest } from "@/lib/hf-auth";
import type { ProviderId } from "@/lib/providers";

export const OPENAI_AUTH_MISSING_MESSAGE = "Provide OpenAI API key.";
export const ANTHROPIC_AUTH_MISSING_MESSAGE = "Provide Anthropic API key.";
export const GOOGLE_AUTH_MISSING_MESSAGE = "Provide Google API key.";

export class ProviderCredentialError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderCredentialError";
    this.status = status;
  }
}

interface ResolveProviderApiKeyInput {
  request: NextRequest;
  provider: ProviderId;
  hfApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
}

function requireManualKey(
  value: string | undefined,
  message: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ProviderCredentialError(message, 400);
  }

  return trimmed;
}

export function resolveProviderApiKeyFromRequest({
  request,
  provider,
  hfApiKey,
  openaiApiKey,
  anthropicApiKey,
  googleApiKey,
}: ResolveProviderApiKeyInput): string {
  if (provider === "huggingface") {
    try {
      return resolveHfApiKeyFromRequest(request, hfApiKey?.trim());
    } catch (error) {
      if (error instanceof HfCredentialError) {
        throw new ProviderCredentialError(error.message, error.status);
      }

      throw error;
    }
  }

  if (provider === "openai") {
    return requireManualKey(openaiApiKey, OPENAI_AUTH_MISSING_MESSAGE);
  }

  if (provider === "anthropic") {
    return requireManualKey(anthropicApiKey, ANTHROPIC_AUTH_MISSING_MESSAGE);
  }

  return requireManualKey(googleApiKey, GOOGLE_AUTH_MISSING_MESSAGE);
}
