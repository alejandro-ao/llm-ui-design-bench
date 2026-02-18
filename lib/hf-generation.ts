import { OpenAI } from "openai";

export interface HfGenerationAttempt {
  model: string;
  provider: string;
  status: "success" | "error";
  statusCode?: number;
  retryable: boolean;
  durationMs: number;
  detail?: string;
}

export interface HfGenerationResult {
  html: string;
  usedModel: string;
  usedProvider: string;
  attempts: HfGenerationAttempt[];
}

export interface HfStreamAttemptInfo {
  attemptNumber: number;
  totalAttempts: number;
  model: string;
  provider: string;
  resetCode: boolean;
}

export interface HfStreamingCallbacks {
  onAttempt?: (attempt: HfStreamAttemptInfo) => void | Promise<void>;
  onToken?: (token: string) => void | Promise<void>;
  onLog?: (message: string) => void | Promise<void>;
}

export class HFGenerationError extends Error {
  status: number;
  attempts: HfGenerationAttempt[];

  constructor(message: string, status = 500, attempts: HfGenerationAttempt[] = []) {
    super(message);
    this.name = "HFGenerationError";
    this.status = status;
    this.attempts = attempts;
  }
}

interface GenerateWithHfInput {
  hfApiKey: string;
  modelId: string;
  provider?: string;
  billTo?: string;
  prompt: string;
  baselineHtml: string;
  traceId?: string;
}

interface GenerateWithHfStreamingInput extends GenerateWithHfInput, HfStreamingCallbacks {}

export interface HfAttemptPlan {
  model: string;
  provider: string;
}

const DEFAULT_HF_BASE_URL = "https://router.huggingface.co/v1";
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const DEFAULT_GENERATION_TIMEOUT_MS = 1_200_000;
const DEFAULT_GENERATION_MAX_TOKENS = 8_192;
const MIN_ATTEMPT_BUDGET_MS = 1_000;
const SYSTEM_PROMPT =
  "You are an expert frontend engineer. Return only one complete HTML document with embedded CSS and JS. No markdown fences, no explanations.";

type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

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

function isLikelyHtml(value: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(value);
}

function normalizePlainText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findMessageInJson(value: JsonLike): string | null {
  if (typeof value === "string") {
    const trimmed = normalizePlainText(value);
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = findMessageInJson(item);
      if (message) {
        return message;
      }
    }

    return null;
  }

  if (typeof value === "object" && value !== null) {
    const candidateKeys = ["error", "message", "detail", "reason"];
    for (const key of candidateKeys) {
      const nested = findMessageInJson((value as Record<string, JsonLike>)[key]);
      if (nested) {
        return nested;
      }
    }

    for (const nestedValue of Object.values(value)) {
      const nested = findMessageInJson(nestedValue);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function extractErrorDetail(rawValue: unknown): string | null {
  if (typeof rawValue === "string") {
    if (isLikelyHtml(rawValue)) {
      return null;
    }

    const normalized = normalizePlainText(rawValue);
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof rawValue === "object" && rawValue !== null) {
    return findMessageInJson(rawValue as JsonLike);
  }

  return null;
}

function buildProviderErrorMessage(status: number, detail: string | null): string {
  const shortDetail = detail ? detail.slice(0, 220) : null;

  if (status === 401 || status === 403) {
    return "Invalid Hugging Face API key.";
  }

  if (status === 404) {
    return "Model ID or provider not found on Hugging Face inference providers.";
  }

  if (status === 408 || status === 504) {
    return "Hugging Face provider timed out. Try another provider, retry, or use a faster model.";
  }

  if (status === 429) {
    return "Hugging Face rate limit reached. Retry in a moment.";
  }

  if (status >= 500) {
    return "Hugging Face provider is temporarily unavailable. Retry shortly.";
  }

  if (shortDetail) {
    return `Hugging Face request failed (${status}): ${shortDetail}`;
  }

  return `Hugging Face request failed (${status}).`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function resolveHfBaseUrl(rawBaseUrl: string | undefined): string {
  const input = rawBaseUrl?.trim();
  if (!input) {
    return DEFAULT_HF_BASE_URL;
  }

  try {
    const url = new URL(input);
    let pathname = url.pathname.replace(/\/+$/, "");

    if (pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
      pathname = pathname.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
    }

    if (!pathname || pathname === "/") {
      pathname = "/v1";
    } else if (pathname === "/v1") {
      // Keep as-is.
    } else if (pathname.startsWith("/v1/")) {
      pathname = "/v1";
    }

    return `${url.origin}${pathname}`;
  } catch {
    const trimmed = input.replace(/\/+$/, "");
    if (trimmed.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
      return trimmed.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
    }

    if (trimmed.endsWith("/v1")) {
      return trimmed;
    }

    return `${trimmed}/v1`;
  }
}

export function buildHfAttemptPlan(modelId: string, providerInput: string | undefined): HfAttemptPlan[] {
  const provider = providerInput?.trim().toLowerCase();

  if (provider) {
    return [
      {
        model: `${modelId}:${provider}`,
        provider,
      },
      {
        model: modelId,
        provider: "auto",
      },
    ];
  }

  return [
    {
      model: modelId,
      provider: "auto",
    },
  ];
}

function resolveGenerationTimeoutMs(rawTimeout: string | undefined): number {
  const parsed = Number.parseInt(rawTimeout ?? "", 10);

  if (Number.isFinite(parsed) && parsed >= MIN_ATTEMPT_BUDGET_MS) {
    return parsed;
  }

  return DEFAULT_GENERATION_TIMEOUT_MS;
}

function resolveGenerationMaxTokens(rawMaxTokens: string | undefined): number {
  const parsed = Number.parseInt(rawMaxTokens ?? "", 10);

  if (Number.isFinite(parsed) && parsed >= 256) {
    return parsed;
  }

  return DEFAULT_GENERATION_MAX_TOKENS;
}

function summarizeAttempts(attempts: HfGenerationAttempt[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => ({
    model: attempt.model,
    provider: attempt.provider,
    status: attempt.status,
    statusCode: attempt.statusCode,
    retryable: attempt.retryable,
    durationMs: attempt.durationMs,
    detail: attempt.detail,
  }));
}

function logHfGeneration(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  if (level === "info") {
    console.info(`[hf-generation] ${event}`, fields);
    return;
  }

  if (level === "warn") {
    console.warn(`[hf-generation] ${event}`, fields);
    return;
  }

  console.error(`[hf-generation] ${event}`, fields);
}

function parseOpenAiError(error: unknown): {
  status: number;
  detail: string | null;
  retryable: boolean;
} {
  const maybeError = error as {
    status?: unknown;
    message?: unknown;
    error?: unknown;
    code?: unknown;
    cause?: unknown;
    name?: unknown;
  };

  const status =
    typeof maybeError.status === "number" && Number.isFinite(maybeError.status)
      ? maybeError.status
      : null;
  const detail =
    extractErrorDetail(maybeError.error) ??
    extractErrorDetail(maybeError.message) ??
    extractErrorDetail(maybeError.cause);

  if (status !== null) {
    return {
      status,
      detail,
      retryable: isRetryableStatus(status),
    };
  }

  const errorCode = typeof maybeError.code === "string" ? maybeError.code.toUpperCase() : null;
  const errorName = typeof maybeError.name === "string" ? maybeError.name : "";

  if (
    errorName === "AbortError" ||
    errorName === "APIConnectionTimeoutError" ||
    errorCode === "ETIMEDOUT" ||
    errorCode === "ECONNRESET" ||
    errorCode === "ENOTFOUND" ||
    errorCode === "EAI_AGAIN"
  ) {
    return {
      status: 504,
      detail,
      retryable: true,
    };
  }

  return {
    status: 502,
    detail,
    retryable: true,
  };
}

function isStreamingUnsupportedError(status: number, detail: string | null): boolean {
  if (status !== 400 && status !== 404 && status !== 422) {
    return false;
  }

  if (!detail) {
    return false;
  }

  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stream") ||
    normalized.includes("streaming") ||
    normalized.includes("not supported") ||
    normalized.includes("unsupported")
  );
}

function createOpenAiClient({
  hfApiKey,
  timeoutMs,
  baseUrl,
  billTo,
}: {
  hfApiKey: string;
  timeoutMs: number;
  baseUrl: string;
  billTo?: string;
}): OpenAI {
  return new OpenAI({
    apiKey: hfApiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: timeoutMs,
    ...(billTo
      ? {
          defaultHeaders: {
            "X-HF-Bill-To": billTo,
          },
        }
      : {}),
  });
}

function buildChatMessages(prompt: string, baselineHtml: string) {
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: buildUserPrompt(prompt, baselineHtml),
    },
  ];
}

export function extractHtmlDocument(rawContent: string): string {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new HFGenerationError("Model returned empty output.", 422);
  }

  const fenced = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;

  const lowerCandidate = candidate.toLowerCase();
  const doctypeIndex = lowerCandidate.indexOf("<!doctype html");
  const htmlIndex = lowerCandidate.indexOf("<html");

  if (doctypeIndex >= 0) {
    const endIndex = lowerCandidate.lastIndexOf("</html>");
    if (endIndex >= 0) {
      return candidate.slice(doctypeIndex, endIndex + "</html>".length).trim();
    }

    return candidate.slice(doctypeIndex).trim();
  }

  if (htmlIndex >= 0) {
    const endIndex = lowerCandidate.lastIndexOf("</html>");
    if (endIndex >= 0) {
      return candidate.slice(htmlIndex, endIndex + "</html>".length).trim();
    }

    return candidate.slice(htmlIndex).trim();
  }

  throw new HFGenerationError("Model output does not contain a full HTML document.", 422);
}

function buildUserPrompt(prompt: string, baselineHtml: string): string {
  return [
    prompt,
    "",
    "Use this baseline HTML as input context:",
    "```html",
    baselineHtml,
    "```",
  ].join("\n");
}

export async function generateHtmlWithHuggingFace({
  hfApiKey,
  modelId,
  provider,
  billTo,
  prompt,
  baselineHtml,
  traceId,
}: GenerateWithHfInput): Promise<HfGenerationResult> {
  const requestId = traceId?.trim() || `hf-${Date.now().toString(36)}`;
  const timeoutMs = resolveGenerationTimeoutMs(process.env.GENERATION_TIMEOUT_MS);
  const maxTokens = resolveGenerationMaxTokens(process.env.GENERATION_MAX_TOKENS);
  const baseUrl = resolveHfBaseUrl(process.env.HF_BASE_URL);
  const attemptPlan = buildHfAttemptPlan(modelId, provider);
  const attempts: HfGenerationAttempt[] = [];
  const deadline = Date.now() + timeoutMs;

  logHfGeneration("info", "request_started", {
    requestId,
    modelId,
    provider: provider ?? "auto",
    timeoutMs,
    maxTokens,
    attemptPlan,
    baseUrl,
  });

  for (const [attemptIndex, plan] of attemptPlan.entries()) {
    const remainingBudgetMs = deadline - Date.now();
    if (remainingBudgetMs < MIN_ATTEMPT_BUDGET_MS) {
      logHfGeneration("error", "timeout_budget_exhausted", {
        requestId,
        timeoutMs,
        attempts: summarizeAttempts(attempts),
      });
      throw new HFGenerationError(
        "Generation timed out before another provider attempt could start.",
        504,
        attempts,
      );
    }

    logHfGeneration("info", "attempt_started", {
      requestId,
      attempt: attemptIndex + 1,
      totalAttempts: attemptPlan.length,
      model: plan.model,
      provider: plan.provider,
      remainingBudgetMs,
      maxTokens,
    });

    const client = createOpenAiClient({
      hfApiKey,
      timeoutMs: remainingBudgetMs,
      baseUrl,
      billTo,
    });
    const startedAt = Date.now();

    try {
      const payload = await client.chat.completions.create({
        model: plan.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: buildChatMessages(prompt, baselineHtml),
      });

      const content = coerceMessageContent(payload.choices?.[0]?.message?.content);
      const html = extractHtmlDocument(content);
      const finishReason = payload.choices?.[0]?.finish_reason ?? "unknown";
      const durationMs = Date.now() - startedAt;

      attempts.push({
        model: plan.model,
        provider: plan.provider,
        status: "success",
        retryable: false,
        durationMs,
      });

      logHfGeneration("info", "attempt_succeeded", {
        requestId,
        attempt: attemptIndex + 1,
        totalAttempts: attemptPlan.length,
        model: plan.model,
        provider: plan.provider,
        durationMs,
        finishReason,
        outputChars: html.length,
        usage: payload.usage ?? null,
      });

      if (finishReason === "length") {
        logHfGeneration("warn", "attempt_finish_reason_length", {
          requestId,
          attempt: attemptIndex + 1,
          model: plan.model,
          provider: plan.provider,
          outputChars: html.length,
          usage: payload.usage ?? null,
        });
      }

      return {
        html,
        usedModel: plan.model,
        usedProvider: plan.provider,
        attempts,
      };
    } catch (error) {
      if (error instanceof HFGenerationError && error.status === 422) {
        const durationMs = Date.now() - startedAt;
        attempts.push({
          model: plan.model,
          provider: plan.provider,
          status: "error",
          statusCode: error.status,
          retryable: false,
          durationMs,
          detail: error.message,
        });

        logHfGeneration("warn", "attempt_invalid_html", {
          requestId,
          attempt: attemptIndex + 1,
          totalAttempts: attemptPlan.length,
          model: plan.model,
          provider: plan.provider,
          durationMs,
          detail: error.message,
        });

        logHfGeneration("error", "request_failed", {
          requestId,
          status: error.status,
          detail: error.message,
          attempts: summarizeAttempts(attempts),
        });

        throw new HFGenerationError(error.message, error.status, attempts);
      }

      const parsed = parseOpenAiError(error);
      const userMessage = buildProviderErrorMessage(parsed.status, parsed.detail);
      const canRetry = parsed.retryable && attemptIndex < attemptPlan.length - 1;
      const durationMs = Date.now() - startedAt;

      attempts.push({
        model: plan.model,
        provider: plan.provider,
        status: "error",
        statusCode: parsed.status,
        retryable: canRetry,
        durationMs,
        detail: userMessage,
      });

      logHfGeneration(canRetry ? "warn" : "error", "attempt_failed", {
        requestId,
        attempt: attemptIndex + 1,
        totalAttempts: attemptPlan.length,
        model: plan.model,
        provider: plan.provider,
        durationMs,
        status: parsed.status,
        retryable: canRetry,
        upstreamDetail: parsed.detail,
        userMessage,
      });

      if (!canRetry) {
        logHfGeneration("error", "request_failed", {
          requestId,
          status: parsed.status,
          detail: userMessage,
          attempts: summarizeAttempts(attempts),
        });
        throw new HFGenerationError(userMessage, parsed.status, attempts);
      }
    }
  }

  logHfGeneration("error", "request_failed_no_attempt_succeeded", {
    requestId,
    attempts: summarizeAttempts(attempts),
  });

  throw new HFGenerationError(
    "Unable to contact Hugging Face providers.",
    502,
    attempts,
  );
}

export async function generateHtmlWithHuggingFaceStreamed({
  hfApiKey,
  modelId,
  provider,
  billTo,
  prompt,
  baselineHtml,
  traceId,
  onAttempt,
  onToken,
  onLog,
}: GenerateWithHfStreamingInput): Promise<HfGenerationResult> {
  const requestId = traceId?.trim() || `hf-stream-${Date.now().toString(36)}`;
  const timeoutMs = resolveGenerationTimeoutMs(process.env.GENERATION_TIMEOUT_MS);
  const baseUrl = resolveHfBaseUrl(process.env.HF_BASE_URL);
  const attemptPlan = buildHfAttemptPlan(modelId, provider);
  const attempts: HfGenerationAttempt[] = [];
  const deadline = Date.now() + timeoutMs;

  for (const [attemptIndex, plan] of attemptPlan.entries()) {
    const remainingBudgetMs = deadline - Date.now();
    if (remainingBudgetMs < MIN_ATTEMPT_BUDGET_MS) {
      throw new HFGenerationError(
        "Generation timed out before another provider attempt could start.",
        504,
        attempts,
      );
    }

    const client = createOpenAiClient({
      hfApiKey,
      timeoutMs: remainingBudgetMs,
      baseUrl,
      billTo,
    });
    const startedAt = Date.now();
    await onAttempt?.({
      attemptNumber: attemptIndex + 1,
      totalAttempts: attemptPlan.length,
      model: plan.model,
      provider: plan.provider,
      resetCode: attemptIndex > 0,
    });
    await onLog?.(`Starting attempt ${attemptIndex + 1}/${attemptPlan.length} with ${plan.model}.`);

    let rawContent = "";

    try {
      const stream = await client.chat.completions.create({
        model: plan.model,
        temperature: 0.2,
        messages: buildChatMessages(prompt, baselineHtml),
        stream: true,
      });

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
        model: plan.model,
        provider: plan.provider,
        status: "success",
        retryable: false,
        durationMs: Date.now() - startedAt,
      });

      return {
        html,
        usedModel: plan.model,
        usedProvider: plan.provider,
        attempts,
      };
    } catch (error) {
      if (error instanceof HFGenerationError && error.status === 422) {
        attempts.push({
          model: plan.model,
          provider: plan.provider,
          status: "error",
          statusCode: error.status,
          retryable: false,
          durationMs: Date.now() - startedAt,
          detail: error.message,
        });
        throw new HFGenerationError(error.message, error.status, attempts);
      }

      const parsed = parseOpenAiError(error);

      if (isStreamingUnsupportedError(parsed.status, parsed.detail)) {
        attempts.push({
          model: plan.model,
          provider: plan.provider,
          status: "error",
          statusCode: parsed.status,
          retryable: false,
          durationMs: Date.now() - startedAt,
          detail: "Provider does not support streaming; falling back to non-stream response.",
        });
        await onLog?.("Provider does not support streaming. Falling back to non-stream response.");
        await onAttempt?.({
          attemptNumber: 1,
          totalAttempts: 1,
          model: plan.model,
          provider: plan.provider,
          resetCode: true,
        });

        try {
          const fallback = await generateHtmlWithHuggingFace({
            hfApiKey,
            modelId,
            provider,
            billTo,
            prompt,
            baselineHtml,
            traceId: requestId,
          });

          await onToken?.(fallback.html);

          return {
            ...fallback,
            attempts: [...attempts, ...fallback.attempts],
          };
        } catch (fallbackError) {
          if (fallbackError instanceof HFGenerationError) {
            throw new HFGenerationError(
              fallbackError.message,
              fallbackError.status,
              [...attempts, ...fallbackError.attempts],
            );
          }

          throw fallbackError;
        }
      }

      const userMessage = buildProviderErrorMessage(parsed.status, parsed.detail);
      const canRetry = parsed.retryable && attemptIndex < attemptPlan.length - 1;

      attempts.push({
        model: plan.model,
        provider: plan.provider,
        status: "error",
        statusCode: parsed.status,
        retryable: canRetry,
        durationMs: Date.now() - startedAt,
        detail: userMessage,
      });

      if (!canRetry) {
        throw new HFGenerationError(userMessage, parsed.status, attempts);
      }

      await onLog?.(`Attempt ${attemptIndex + 1} failed. Retrying.`);
    }
  }

  throw new HFGenerationError(
    "Unable to contact Hugging Face providers.",
    502,
    attempts,
  );
}
