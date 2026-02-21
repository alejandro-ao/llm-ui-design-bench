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
interface AnthropicSseEvent {
  event: string;
  payload: unknown;
}

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

function extractAnthropicStopReason(payload: unknown): string | null {
  const maybePayload = payload as {
    delta?: {
      stop_reason?: unknown;
    };
    message?: {
      stop_reason?: unknown;
    };
  };

  const candidates = [
    maybePayload.delta?.stop_reason,
    maybePayload.message?.stop_reason,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function hasClosingHtmlTag(value: string): boolean {
  return /<\/html>/i.test(value);
}

function parseAnthropicSseEvent(block: string): AnthropicSseEvent | null {
  const lines = block.split("\n");
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawPayload = dataLines.join("\n").trim();
  if (!rawPayload || rawPayload === "[DONE]") {
    return null;
  }

  try {
    return {
      event: eventName,
      payload: JSON.parse(rawPayload) as unknown,
    };
  } catch {
    return null;
  }
}

function extractAnthropicStreamToken(event: string, payload: unknown): string {
  const maybePayload = payload as {
    delta?: {
      type?: unknown;
      text?: unknown;
    };
    content_block?: {
      type?: unknown;
      text?: unknown;
    };
  };

  if (
    event === "content_block_delta" &&
    maybePayload.delta?.type === "text_delta" &&
    typeof maybePayload.delta.text === "string"
  ) {
    return maybePayload.delta.text;
  }

  if (
    event === "content_block_start" &&
    maybePayload.content_block?.type === "text" &&
    typeof maybePayload.content_block.text === "string"
  ) {
    return maybePayload.content_block.text;
  }

  return "";
}

function mergeAnthropicStreamUsage(
  previous: GenerationUsage | null,
  payload: unknown,
): GenerationUsage | null {
  const maybePayload = payload as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
    message?: {
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cache_read_input_tokens?: unknown;
      };
    };
  };

  const usage = normalizeGenerationUsage({
    inputTokens:
      maybePayload.message?.usage?.input_tokens ??
      maybePayload.usage?.input_tokens ??
      previous?.inputTokens,
    outputTokens:
      maybePayload.message?.usage?.output_tokens ??
      maybePayload.usage?.output_tokens ??
      previous?.outputTokens,
    cachedInputTokens:
      maybePayload.message?.usage?.cache_read_input_tokens ??
      maybePayload.usage?.cache_read_input_tokens ??
      previous?.cachedInputTokens,
  });

  return usage ?? previous;
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

    const stopReason = extractAnthropicStopReason(payload);
    if (stopReason === "max_tokens" && !hasClosingHtmlTag(text)) {
      throw new GenerationError(
        "Anthropic output was truncated because max_tokens was reached before </html>. Increase GENERATION_MAX_TOKENS.",
        422,
      );
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

async function requestAnthropicStreamed({
  apiKey,
  modelId,
  prompt,
  baselineHtml,
  onToken,
}: GenerateWithAnthropicStreamedInput): Promise<{
  html: string;
  usage: GenerationUsage | null;
  stopReason: string | null;
}> {
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
        stream: true,
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

    if (!response.ok) {
      const rawBody = (await response.text()) || "";
      const payload = safeParseJson(rawBody);
      throw new GenerationError(
        extractAnthropicError(payload) || `Anthropic request failed (${response.status}).`,
        response.status,
      );
    }

    if (!response.body) {
      throw new GenerationError("Anthropic stream returned no response body.", 502);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let rawText = "";
    let usage: GenerationUsage | null = null;
    let stopReason: string | null = null;

    const processBlock = async (block: string): Promise<void> => {
      const parsed = parseAnthropicSseEvent(block);
      if (!parsed) {
        return;
      }

      if (parsed.event === "error") {
        throw new GenerationError(
          extractAnthropicError(parsed.payload) || "Anthropic stream returned an error event.",
          502,
        );
      }

      const token = extractAnthropicStreamToken(parsed.event, parsed.payload);
      if (token) {
        rawText += token;
        await onToken?.(token);
      }

      usage = mergeAnthropicStreamUsage(usage, parsed.payload);
      stopReason = extractAnthropicStopReason(parsed.payload) ?? stopReason;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        await processBlock(block);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode().replace(/\r/g, "");
    if (buffer.trim()) {
      await processBlock(buffer);
    }

    if (!rawText.trim()) {
      throw new GenerationError("Anthropic returned empty output.", 422);
    }

    if (stopReason === "max_tokens" && !hasClosingHtmlTag(rawText)) {
      throw new GenerationError(
        "Anthropic output was truncated because max_tokens was reached before </html>. Increase GENERATION_MAX_TOKENS.",
        422,
      );
    }

    return {
      html: extractHtmlDocument(rawText),
      usage,
      stopReason,
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

export async function generateHtmlWithAnthropicStreamed({
  onAttempt,
  onToken,
  onLog,
  ...input
}: GenerateWithAnthropicStreamedInput): Promise<GenerationResult> {
  const attempts: GenerationAttempt[] = [];
  const startedAt = Date.now();

  await onAttempt?.({
    attemptNumber: 1,
    totalAttempts: 1,
    model: input.modelId,
    provider: "anthropic",
    resetCode: false,
  });
  await onLog?.("Starting Anthropic generation.");

  try {
    const result = await requestAnthropicStreamed({
      ...input,
      onToken,
    });
    if (result.stopReason === "max_tokens") {
      await onLog?.(
        "Anthropic stop_reason=max_tokens. Output may be truncated; consider increasing GENERATION_MAX_TOKENS.",
      );
    }

    attempts.push({
      model: input.modelId,
      provider: "anthropic",
      status: "success",
      retryable: false,
      durationMs: Date.now() - startedAt,
      ...(result.usage ? { usage: result.usage } : {}),
    });

    return {
      html: result.html,
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
