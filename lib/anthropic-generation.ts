import { extractHtmlDocument } from "@/lib/hf-generation";
import {
  buildUserPrompt,
  GenerationAttempt,
  GenerationError,
  GenerationResult,
  type GenerationUsage,
  StreamingCallbacks,
  SYSTEM_PROMPT,
} from "@/lib/generation-types";
import { normalizeGenerationUsage } from "@/lib/pricing";

interface GenerateWithAnthropicInput {
  apiKey: string;
  modelId: string;
  prompt: string;
  baselineHtml: string;
}

interface GenerateWithAnthropicStreamedInput extends GenerateWithAnthropicInput, StreamingCallbacks {}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 32_768;

function resolveAnthropicMaxTokens(rawMaxTokens: string | undefined): number {
  const parsed = Number.parseInt(rawMaxTokens ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 256) {
    return parsed;
  }

  return DEFAULT_MAX_TOKENS;
}

function extractAnthropicText(payload: unknown): string {
  const maybePayload = payload as {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };

  if (!Array.isArray(maybePayload.content)) {
    return "";
  }

  return maybePayload.content
    .map((item) => (item.type === "text" ? item.text ?? "" : ""))
    .join("\n")
    .trim();
}

function extractAnthropicError(payload: unknown): string | null {
  const maybePayload = payload as {
    error?: {
      message?: unknown;
      type?: unknown;
    };
  };

  if (typeof maybePayload.error?.message === "string" && maybePayload.error.message.trim()) {
    return maybePayload.error.message.trim();
  }

  if (typeof maybePayload.error?.type === "string" && maybePayload.error.type.trim()) {
    return maybePayload.error.type.trim();
  }

  return null;
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

function extractAnthropicUsage(payload: unknown): GenerationUsage | null {
  const maybePayload = payload as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };

  return normalizeGenerationUsage({
    inputTokens: maybePayload.usage?.input_tokens,
    outputTokens: maybePayload.usage?.output_tokens,
    cachedInputTokens: maybePayload.usage?.cache_read_input_tokens,
  });
}

function buildAnthropicUrl(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
}

async function requestAnthropic({
  apiKey,
  modelId,
  prompt,
  baselineHtml,
}: GenerateWithAnthropicInput): Promise<{ html: string; usage: GenerationUsage | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(buildAnthropicUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": process.env.ANTHROPIC_VERSION?.trim() || "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: resolveAnthropicMaxTokens(process.env.GENERATION_MAX_TOKENS),
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserPrompt(prompt, baselineHtml),
          },
        ],
      }),
      signal: controller.signal,
    });

    const rawBody = (await response.text()) || "";
    const payload = safeParseJson(rawBody);

    if (!response.ok) {
      throw new GenerationError(
        extractAnthropicError(payload) || `Anthropic request failed (${response.status}).`,
        response.status,
      );
    }

    const text = extractAnthropicText(payload);
    if (!text) {
      throw new GenerationError("Anthropic returned empty output.", 422);
    }

    return {
      html: extractHtmlDocument(text),
      usage: extractAnthropicUsage(payload),
    };
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GenerationError("Anthropic request timed out.", 504);
    }

    throw new GenerationError("Unable to generate output from Anthropic.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateHtmlWithAnthropic(
  input: GenerateWithAnthropicInput,
): Promise<GenerationResult> {
  const attempts: GenerationAttempt[] = [];
  const startedAt = Date.now();

  try {
    const response = await requestAnthropic(input);
    attempts.push({
      model: input.modelId,
      provider: "anthropic",
      status: "success",
      retryable: false,
      durationMs: Date.now() - startedAt,
      ...(response.usage ? { usage: response.usage } : {}),
    });

    return {
      html: response.html,
      usedModel: input.modelId,
      usedProvider: "anthropic",
      attempts,
    };
  } catch (error) {
    const status = error instanceof GenerationError ? error.status : 502;
    const message =
      error instanceof GenerationError ? error.message : "Unable to generate output from Anthropic.";

    attempts.push({
      model: input.modelId,
      provider: "anthropic",
      status: "error",
      statusCode: status,
      retryable: false,
      durationMs: Date.now() - startedAt,
      detail: message,
    });

    throw new GenerationError(message, status, attempts);
  }
}

export async function generateHtmlWithAnthropicStreamed({
  onAttempt,
  onToken,
  onLog,
  ...input
}: GenerateWithAnthropicStreamedInput): Promise<GenerationResult> {
  await onAttempt?.({
    attemptNumber: 1,
    totalAttempts: 1,
    model: input.modelId,
    provider: "anthropic",
    resetCode: false,
  });
  await onLog?.("Starting Anthropic generation.");

  const result = await generateHtmlWithAnthropic(input);
  await onToken?.(result.html);

  return result;
}
