import { OpenAI } from "openai";

import { extractHtmlDocument } from "@/lib/hf-generation";
import {
  buildUserPrompt,
  GenerationAttempt,
  GenerationError,
  GenerationResult,
  StreamingCallbacks,
  SYSTEM_PROMPT,
} from "@/lib/generation-types";

interface GenerateWithOpenAiInput {
  apiKey: string;
  modelId: string;
  prompt: string;
  baselineHtml: string;
}

interface GenerateWithOpenAiStreamedInput extends GenerateWithOpenAiInput, StreamingCallbacks {}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 32_768;

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

export async function generateHtmlWithOpenAi({
  apiKey,
  modelId,
  prompt,
  baselineHtml,
}: GenerateWithOpenAiInput): Promise<GenerationResult> {
  const attempts: GenerationAttempt[] = [];
  const startedAt = Date.now();

  try {
    const client = buildOpenAiClient(apiKey);
    const payload = await client.chat.completions.create({
      model: modelId,
      temperature: 0.2,
      max_completion_tokens: resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS),
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildUserPrompt(prompt, baselineHtml),
        },
      ],
    });

    const content = coerceMessageContent(payload.choices?.[0]?.message?.content);
    const html = extractHtmlDocument(content);

    attempts.push({
      model: modelId,
      provider: "openai",
      status: "success",
      retryable: false,
      durationMs: Date.now() - startedAt,
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
    const stream = await client.chat.completions.create({
      model: modelId,
      temperature: 0.2,
      max_completion_tokens: resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS),
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildUserPrompt(prompt, baselineHtml),
        },
      ],
      stream: true,
    });

    let rawContent = "";

    for await (const chunk of stream) {
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
