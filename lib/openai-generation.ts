import { OpenAI } from "openai";

import { extractHtmlDocument } from "@/lib/hf-generation";
import {
  buildUserPrompt,
  GenerationAttempt,
  GenerationError,
  type GenerationReferenceImage,
  GenerationResult,
  StreamingCallbacks,
  SYSTEM_PROMPT,
} from "@/lib/generation-types";
import { normalizeGenerationUsage } from "@/lib/pricing";

interface GenerateWithOpenAiInput {
  apiKey: string;
  modelId: string;
  prompt: string;
  baselineHtml: string;
  referenceImage?: GenerationReferenceImage;
}

interface GenerateWithOpenAiStreamedInput extends GenerateWithOpenAiInput, StreamingCallbacks {}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 32_768;

function normalizeOpenAiUsage(usage: unknown) {
  const usagePayload = (usage ?? {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens_details?: {
      cached_tokens?: unknown;
    };
  };

  return normalizeGenerationUsage({
    inputTokens: usagePayload.prompt_tokens,
    outputTokens: usagePayload.completion_tokens,
    totalTokens: usagePayload.total_tokens,
    cachedInputTokens: usagePayload.prompt_tokens_details?.cached_tokens,
  });
}

function coerceMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (typeof item === "object" && item !== null) {
          const maybeText = (item as { text?: unknown }).text;
          if (typeof maybeText === "string") {
            return maybeText;
          }
        }

        return "";
      })
      .join("\n");
  }

  return "";
}

function parseOpenAiError(error: unknown): { status: number; detail: string } {
  const maybeError = error as {
    status?: unknown;
    message?: unknown;
    error?: unknown;
  };

  const status =
    typeof maybeError.status === "number" && Number.isFinite(maybeError.status)
      ? maybeError.status
      : 502;

  if (typeof maybeError.message === "string" && maybeError.message.trim()) {
    return {
      status,
      detail: maybeError.message.trim(),
    };
  }

  if (typeof maybeError.error === "string" && maybeError.error.trim()) {
    return {
      status,
      detail: maybeError.error.trim(),
    };
  }

  return {
    status,
    detail: "OpenAI request failed.",
  };
}

function resolveGenerationMaxTokens(rawMaxTokens: string | undefined): number {
  const parsed = Number.parseInt(rawMaxTokens ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 256) {
    return parsed;
  }

  return DEFAULT_MAX_TOKENS;
}

function buildOpenAiClient(apiKey: string): OpenAI {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;

  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });
}

function buildReferenceImageDataUrl(referenceImage: GenerationReferenceImage): string {
  return `data:${referenceImage.mimeType};base64,${referenceImage.base64Data}`;
}

function buildOpenAiMessages(
  prompt: string,
  baselineHtml: string,
  referenceImage: GenerationReferenceImage | undefined,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const userPrompt = buildUserPrompt(prompt, baselineHtml);

  if (!referenceImage) {
    return [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: userPrompt,
        },
        {
          type: "image_url",
          image_url: {
            url: buildReferenceImageDataUrl(referenceImage),
          },
        },
      ],
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

export async function generateHtmlWithOpenAi({
  apiKey,
  modelId,
  prompt,
  baselineHtml,
  referenceImage,
}: GenerateWithOpenAiInput): Promise<GenerationResult> {
  const attempts: GenerationAttempt[] = [];
  const startedAt = Date.now();

  try {
    const client = buildOpenAiClient(apiKey);
    let payload: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      payload = await client.chat.completions.create({
        model: modelId,
        temperature: 0.2,
        max_completion_tokens: resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS),
        messages: buildOpenAiMessages(prompt, baselineHtml, referenceImage),
      });
    } catch (error) {
      const parsed = parseOpenAiError(error);
      if (!referenceImage || !isUnsupportedImageInputError(parsed.status, parsed.detail)) {
        throw error;
      }

      payload = await client.chat.completions.create({
        model: modelId,
        temperature: 0.2,
        max_completion_tokens: resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS),
        messages: buildOpenAiMessages(prompt, baselineHtml, undefined),
      });
    }
    const usage = normalizeOpenAiUsage(payload.usage);

    const content = coerceMessageContent(payload.choices?.[0]?.message?.content);
    const html = extractHtmlDocument(content);

    attempts.push({
      model: modelId,
      provider: "openai",
      status: "success",
      retryable: false,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
    });

    return {
      html,
      usedModel: modelId,
      usedProvider: "openai",
      attempts,
    };
  } catch (error) {
    const parsed = parseOpenAiError(error);

    attempts.push({
      model: modelId,
      provider: "openai",
      status: "error",
      statusCode: parsed.status,
      retryable: false,
      durationMs: Date.now() - startedAt,
      detail: parsed.detail,
    });

    throw new GenerationError(parsed.detail, parsed.status, attempts);
  }
}

export async function generateHtmlWithOpenAiStreamed({
  apiKey,
  modelId,
  prompt,
  baselineHtml,
  referenceImage,
  onAttempt,
  onToken,
}: GenerateWithOpenAiStreamedInput): Promise<GenerationResult> {
  const attempts: GenerationAttempt[] = [];
  const startedAt = Date.now();

  await onAttempt?.({
    attemptNumber: 1,
    totalAttempts: 1,
    model: modelId,
    provider: "openai",
    resetCode: false,
  });

  try {
    const client = buildOpenAiClient(apiKey);
    let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      stream = await client.chat.completions.create({
        model: modelId,
        temperature: 0.2,
        max_completion_tokens: resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS),
        messages: buildOpenAiMessages(prompt, baselineHtml, referenceImage),
        stream: true,
        stream_options: {
          include_usage: true,
        },
      });
    } catch (error) {
      const parsed = parseOpenAiError(error);
      if (!referenceImage || !isUnsupportedImageInputError(parsed.status, parsed.detail)) {
        throw error;
      }

      stream = await client.chat.completions.create({
        model: modelId,
        temperature: 0.2,
        max_completion_tokens: resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS),
        messages: buildOpenAiMessages(prompt, baselineHtml, undefined),
        stream: true,
        stream_options: {
          include_usage: true,
        },
      });
    }

    let rawContent = "";
    let usage = null;

    for await (const chunk of stream) {
      const chunkUsage = normalizeOpenAiUsage((chunk as { usage?: unknown }).usage);
      if (chunkUsage) {
        usage = chunkUsage;
      }

      const token = coerceMessageContent(chunk.choices?.[0]?.delta?.content);
      if (!token) {
        continue;
      }

      rawContent += token;
      await onToken?.(token);
    }

    const html = extractHtmlDocument(rawContent);

    attempts.push({
      model: modelId,
      provider: "openai",
      status: "success",
      retryable: false,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
    });

    return {
      html,
      usedModel: modelId,
      usedProvider: "openai",
      attempts,
    };
  } catch (error) {
    const parsed = parseOpenAiError(error);

    attempts.push({
      model: modelId,
      provider: "openai",
      status: "error",
      statusCode: parsed.status,
      retryable: false,
      durationMs: Date.now() - startedAt,
      detail: parsed.detail,
    });

    throw new GenerationError(parsed.detail, parsed.status, attempts);
  }
}
