import {
  generateHtmlWithAnthropic,
  generateHtmlWithAnthropicStreamed,
} from "@/lib/anthropic-generation";
import {
  type GenerationReferenceImage,
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
import { applyPricingToGenerationResult } from "@/lib/pricing";
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
  referenceImage?: GenerationReferenceImage;
  traceId?: string;
}

export interface GenerateHtmlStreamedInput
  extends GenerateHtmlInput,
    StreamingCallbacks {}

export async function generateHtml(input: GenerateHtmlInput): Promise<GenerationResult> {
  if (input.provider === "huggingface") {
    try {
      const generation = await generateHtmlWithHuggingFace({
        hfApiKey: input.apiKey,
        modelId: input.modelId,
        provider: input.providerHint,
        providers: input.providerCandidates,
        billTo: input.billTo,
        prompt: input.prompt,
        baselineHtml: input.baselineHtml,
        referenceImage: input.referenceImage,
        traceId: input.traceId,
      });
      return applyPricingToGenerationResult("huggingface", generation);
    } catch (error) {
      if (error instanceof HFGenerationError) {
        throw new GenerationError(error.message, error.status, error.attempts);
      }

      throw error;
    }
  }

  if (input.provider === "openai") {
    const generation = await generateHtmlWithOpenAi({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
      referenceImage: input.referenceImage,
    });
    return applyPricingToGenerationResult("openai", generation);
  }

  if (input.provider === "anthropic") {
    const generation = await generateHtmlWithAnthropic({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
      referenceImage: input.referenceImage,
    });
    return applyPricingToGenerationResult("anthropic", generation);
  }

  const generation = await generateHtmlWithGoogle({
    apiKey: input.apiKey,
    modelId: input.modelId,
    prompt: input.prompt,
    baselineHtml: input.baselineHtml,
    referenceImage: input.referenceImage,
  });
  return applyPricingToGenerationResult("google", generation);
}

export async function generateHtmlStreamed(
  input: GenerateHtmlStreamedInput,
): Promise<GenerationResult> {
  if (input.provider === "huggingface") {
    try {
      const generation = await generateHtmlWithHuggingFaceStreamed({
        hfApiKey: input.apiKey,
        modelId: input.modelId,
        provider: input.providerHint,
        providers: input.providerCandidates,
        billTo: input.billTo,
        prompt: input.prompt,
        baselineHtml: input.baselineHtml,
        referenceImage: input.referenceImage,
        traceId: input.traceId,
        onAttempt: input.onAttempt,
        onToken: input.onToken,
        onLog: input.onLog,
      });
      return applyPricingToGenerationResult("huggingface", generation);
    } catch (error) {
      if (error instanceof HFGenerationError) {
        throw new GenerationError(error.message, error.status, error.attempts);
      }

      throw error;
    }
  }

  if (input.provider === "openai") {
    const generation = await generateHtmlWithOpenAiStreamed({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
      referenceImage: input.referenceImage,
      onAttempt: input.onAttempt,
      onToken: input.onToken,
      onLog: input.onLog,
    });
    return applyPricingToGenerationResult("openai", generation);
  }

  if (input.provider === "anthropic") {
    const generation = await generateHtmlWithAnthropicStreamed({
      apiKey: input.apiKey,
      modelId: input.modelId,
      prompt: input.prompt,
      baselineHtml: input.baselineHtml,
      referenceImage: input.referenceImage,
      onAttempt: input.onAttempt,
      onToken: input.onToken,
      onLog: input.onLog,
    });
    return applyPricingToGenerationResult("anthropic", generation);
  }

  const generation = await generateHtmlWithGoogleStreamed({
    apiKey: input.apiKey,
    modelId: input.modelId,
    prompt: input.prompt,
    baselineHtml: input.baselineHtml,
    referenceImage: input.referenceImage,
    onAttempt: input.onAttempt,
    onToken: input.onToken,
    onLog: input.onLog,
  });
  return applyPricingToGenerationResult("google", generation);
}
