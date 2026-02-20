import {
  generateHtmlWithAnthropic,
  generateHtmlWithAnthropicStreamed,
} from "@/lib/anthropic-generation";
import {
  GenerationError,
  GenerationResult,
  StreamingCallbacks,
} from "@/lib/generation-types";
import {
  generateHtmlWithGoogle,
  generateHtmlWithGoogleStreamed,
} from "@/lib/google-generation";
import {
  generateHtmlWithHuggingFace,
  generateHtmlWithHuggingFaceStreamed,
  HFGenerationError,
} from "@/lib/hf-generation";
import {
  generateHtmlWithOpenAi,
  generateHtmlWithOpenAiStreamed,
} from "@/lib/openai-generation";
import type { ProviderId } from "@/lib/providers";

export { GenerationError } from "@/lib/generation-types";

export interface GenerateHtmlInput {
  provider: ProviderId;
  apiKey: string;
  modelId: string;
  providerHint?: string;
  providerCandidates?: string[];
  billTo?: string;
  prompt: string;
  baselineHtml: string;
  traceId?: string;
}

export interface GenerateHtmlStreamedInput
  extends GenerateHtmlInput,
    StreamingCallbacks {}

export async function generateHtml(input: GenerateHtmlInput): Promise<GenerationResult> {
  if (input.provider === "huggingface") {
    try {
      return await generateHtmlWithHuggingFace({
        hfApiKey: input.apiKey,
        modelId: input.modelId,
        provider: input.providerHint,
        providers: input.providerCandidates,
        billTo: input.billTo,
        prompt: input.prompt,
        baselineHtml: input.baselineHtml,
        traceId: input.traceId,
      });
    } catch (error) {
      if (error instanceof HFGenerationError) {
        throw new GenerationError(error.message, error.status, error.attempts);
      }

      throw error;
    }
  }

  if (input.provider === "openai") {
    return generateHtmlWithOpenAi({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
    });
  }

  if (input.provider === "anthropic") {
    return generateHtmlWithAnthropic({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
    });
  }

  return generateHtmlWithGoogle({
    apiKey: input.apiKey,
    modelId: input.modelId,
    prompt: input.prompt,
    baselineHtml: input.baselineHtml,
  });
}

export async function generateHtmlStreamed(
  input: GenerateHtmlStreamedInput,
): Promise<GenerationResult> {
  if (input.provider === "huggingface") {
    try {
      return await generateHtmlWithHuggingFaceStreamed({
        hfApiKey: input.apiKey,
        modelId: input.modelId,
        provider: input.providerHint,
        providers: input.providerCandidates,
        billTo: input.billTo,
        prompt: input.prompt,
        baselineHtml: input.baselineHtml,
        traceId: input.traceId,
        onAttempt: input.onAttempt,
        onToken: input.onToken,
        onLog: input.onLog,
      });
    } catch (error) {
      if (error instanceof HFGenerationError) {
        throw new GenerationError(error.message, error.status, error.attempts);
      }

      throw error;
    }
  }

  if (input.provider === "openai") {
    return generateHtmlWithOpenAiStreamed({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
      onAttempt: input.onAttempt,
      onToken: input.onToken,
      onLog: input.onLog,
    });
  }

  if (input.provider === "anthropic") {
    return generateHtmlWithAnthropicStreamed({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
      onAttempt: input.onAttempt,
      onToken: input.onToken,
      onLog: input.onLog,
    });
  }

  return generateHtmlWithGoogleStreamed({
    apiKey: input.apiKey,
    modelId: input.modelId,
    prompt: input.prompt,
    baselineHtml: input.baselineHtml,
    onAttempt: input.onAttempt,
    onToken: input.onToken,
    onLog: input.onLog,
  });
}
