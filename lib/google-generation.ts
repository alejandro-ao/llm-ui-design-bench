import { extractHtmlDocument } from "@/lib/hf-generation";
import {
  buildUserPrompt,
  GenerationAttempt,
  GenerationError,
  type GenerationReferenceImage,
  GenerationResult,
  type GenerationUsage,
  StreamingCallbacks,
  SYSTEM_PROMPT,
} from "@/lib/generation-types";
import { normalizeGenerationUsage } from "@/lib/pricing";

interface GenerateWithGoogleInput {
  apiKey: string;
  modelId: string;
  prompt: string;
  baselineHtml: string;
  referenceImage?: GenerationReferenceImage;
}

interface GenerateWithGoogleStreamedInput extends GenerateWithGoogleInput, StreamingCallbacks {}

const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

function resolveGoogleMaxOutputTokens(rawMaxTokens: string | undefined): number {
  const parsed = Number.parseInt(rawMaxTokens ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 256) {
    return Math.min(parsed, DEFAULT_MAX_OUTPUT_TOKENS);
  }

  return DEFAULT_MAX_OUTPUT_TOKENS;
}

function safeParseJson(rawBody: string): unknown {
  if (!rawBody.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

function extractGoogleText(payload: unknown): string {
  const maybePayload = payload as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  };

  if (!Array.isArray(maybePayload.candidates) || maybePayload.candidates.length === 0) {
    return "";
  }

  const firstCandidate = maybePayload.candidates[0];
  if (!Array.isArray(firstCandidate.content?.parts)) {
    return "";
  }

  return firstCandidate.content.parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function extractGoogleError(payload: unknown): string | null {
  const maybePayload = payload as {
    error?: {
      message?: unknown;
      status?: unknown;
    };
  };

  if (typeof maybePayload.error?.message === "string" && maybePayload.error.message.trim()) {
    return maybePayload.error.message.trim();
  }

  if (typeof maybePayload.error?.status === "string" && maybePayload.error.status.trim()) {
    return maybePayload.error.status.trim();
  }

  return null;
}

function extractGoogleUsage(payload: unknown): GenerationUsage | null {
  const maybePayload = payload as {
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      totalTokenCount?: unknown;
      cachedContentTokenCount?: unknown;
    };
  };

  return normalizeGenerationUsage({
    inputTokens: maybePayload.usageMetadata?.promptTokenCount,
    outputTokens: maybePayload.usageMetadata?.candidatesTokenCount,
    totalTokens: maybePayload.usageMetadata?.totalTokenCount,
    cachedInputTokens: maybePayload.usageMetadata?.cachedContentTokenCount,
  });
}

function buildGoogleUrl(modelId: string, apiKey: string): string {
  const baseUrl = process.env.GOOGLE_BASE_URL?.trim() || DEFAULT_GOOGLE_BASE_URL;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function buildGoogleUserParts(
  prompt: string,
  baselineHtml: string,
  referenceImage: GenerationReferenceImage | undefined,
): Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> {
  const textPrompt = buildUserPrompt(prompt, baselineHtml);
  if (!referenceImage) {
    return [{ text: textPrompt }];
  }

  return [
    { text: textPrompt },
    {
      inlineData: {
        mimeType: referenceImage.mimeType,
        data: referenceImage.base64Data,
      },
    },
  ];
}

function isUnsupportedImageInputError(status: number, detail: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }

  const normalized = detail.toLowerCase();
  if (!normalized.includes("image")) {
    return false;
  }

  return (
    normalized.includes("not support") ||
    normalized.includes("unsupported") ||
    normalized.includes("only text") ||
    normalized.includes("invalid type")
  );
}

async function requestGoogle({
  apiKey,
  modelId,
  prompt,
  baselineHtml,
  referenceImage,
}: GenerateWithGoogleInput): Promise<{ html: string; usage: GenerationUsage | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(buildGoogleUrl(modelId, apiKey), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: "user",
            parts: buildGoogleUserParts(prompt, baselineHtml, referenceImage),
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: resolveGoogleMaxOutputTokens(process.env.GENERATION_MAX_TOKENS),
        },
      }),
      signal: controller.signal,
    });

    const rawBody = (await response.text()) || "";
    const payload = safeParseJson(rawBody);

    if (!response.ok) {
      throw new GenerationError(
        extractGoogleError(payload) || `Google request failed (${response.status}).`,
        response.status,
      );
    }

    const text = extractGoogleText(payload);
    if (!text) {
      throw new GenerationError("Google returned empty output.", 422);
    }

    return {
      html: extractHtmlDocument(text),
      usage: extractGoogleUsage(payload),
    };
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GenerationError("Google request timed out.", 504);
    }

    throw new GenerationError("Unable to generate output from Google.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateHtmlWithGoogle(
  input: GenerateWithGoogleInput,
): Promise<GenerationResult> {
  const attempts: GenerationAttempt[] = [];
  const startedAt = Date.now();

  try {
    let response: Awaited<ReturnType<typeof requestGoogle>>;

    try {
      response = await requestGoogle(input);
    } catch (error) {
      if (
        input.referenceImage &&
        error instanceof GenerationError &&
        isUnsupportedImageInputError(error.status, error.message)
      ) {
        response = await requestGoogle({
          ...input,
          referenceImage: undefined,
        });
      } else {
        throw error;
      }
    }

    attempts.push({
      model: input.modelId,
      provider: "google",
      status: "success",
      retryable: false,
      durationMs: Date.now() - startedAt,
      ...(response.usage ? { usage: response.usage } : {}),
    });

    return {
      html: response.html,
      usedModel: input.modelId,
      usedProvider: "google",
      attempts,
    };
  } catch (error) {
    const status = error instanceof GenerationError ? error.status : 502;
    const message =
      error instanceof GenerationError ? error.message : "Unable to generate output from Google.";

    attempts.push({
      model: input.modelId,
      provider: "google",
      status: "error",
      statusCode: status,
      retryable: false,
      durationMs: Date.now() - startedAt,
      detail: message,
    });

    throw new GenerationError(message, status, attempts);
  }
}

export async function generateHtmlWithGoogleStreamed({
  onAttempt,
  onToken,
  onLog,
  ...input
}: GenerateWithGoogleStreamedInput): Promise<GenerationResult> {
  await onAttempt?.({
    attemptNumber: 1,
    totalAttempts: 1,
    model: input.modelId,
    provider: "google",
    resetCode: false,
  });
  await onLog?.("Starting Google generation.");

  const result = await generateHtmlWithGoogle(input);
  await onToken?.(result.html);

  return result;
}
