import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { ArtifactError, getArtifactByModelId, upsertArtifact } from "@/lib/artifacts";
import {
  generateHtmlWithHuggingFace,
  HFGenerationError,
  type HfGenerationAttempt,
} from "@/lib/hf-generation";
import { inferVendorFromModelId } from "@/lib/models";
import { PROMPT_VERSION, SHARED_PROMPT } from "@/lib/prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GeneratePayload {
  hfApiKey?: string;
  modelId?: string;
  provider?: string;
}

function jsonError(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json(
    {
      error: message,
      ...extra,
    },
    { status },
  );
}

function deriveModelLabel(modelId: string): string {
  const tokens = modelId.split("/").filter(Boolean);
  const fallback = tokens.at(-1) ?? modelId;
  return fallback.slice(0, 120);
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

function logGenerateRoute(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  if (level === "info") {
    console.info(`[api/generate/hf] ${event}`, fields);
    return;
  }

  if (level === "warn") {
    console.warn(`[api/generate/hf] ${event}`, fields);
    return;
  }

  console.error(`[api/generate/hf] ${event}`, fields);
}

function parseModelAndProvider(
  modelInput: string,
  providerInput: string | undefined,
): { modelId: string; provider?: string } {
  const trimmedModel = modelInput.trim();
  const trimmedProvider = providerInput?.trim();

  if (!trimmedModel) {
    throw new ArtifactError("Model ID is required.", 400);
  }

  let modelId = trimmedModel;
  let provider = trimmedProvider;

  const suffixIndex = trimmedModel.lastIndexOf(":");
  if (suffixIndex > 0 && suffixIndex < trimmedModel.length - 1) {
    modelId = trimmedModel.slice(0, suffixIndex).trim();
    provider = trimmedModel.slice(suffixIndex + 1).trim();
  }

  if (!modelId) {
    throw new ArtifactError("Model ID is required.", 400);
  }

  if (provider && !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(provider)) {
    throw new ArtifactError("Provider format is invalid.", 400);
  }

  return { modelId, provider: provider?.toLowerCase() };
}

async function getBaselineHtml(): Promise<string> {
  const artifact = await getArtifactByModelId("baseline");
  if (artifact?.html) {
    return artifact.html;
  }

  const projectRoot = path.resolve(process.env.PROJECT_ROOT ?? process.cwd());
  const fallbackPath = path.join(projectRoot, "data", "artifacts", "baseline", "index.html");

  return fs.readFile(fallbackPath, "utf8");
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const contentType = request.headers.get("content-type") ?? "";
  logGenerateRoute("info", "request_received", {
    requestId,
    path: request.nextUrl.pathname,
    contentType,
  });

  if (!contentType.includes("application/json")) {
    logGenerateRoute("warn", "request_rejected_content_type", {
      requestId,
      contentType,
    });
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const payload = (await request.json()) as GeneratePayload;

    const hfApiKey = payload.hfApiKey?.trim();
    const modelInput = payload.modelId?.trim();

    if (!hfApiKey) {
      logGenerateRoute("warn", "request_rejected_missing_api_key", {
        requestId,
      });
      return jsonError("Hugging Face API key is required.", 400);
    }

    if (!modelInput) {
      logGenerateRoute("warn", "request_rejected_missing_model_id", {
        requestId,
      });
      return jsonError("Model ID is required.", 400);
    }

    const { modelId, provider } = parseModelAndProvider(modelInput, payload.provider);
    logGenerateRoute("info", "request_validated", {
      requestId,
      modelId,
      provider: provider ?? "auto",
      generationTimeoutMs: process.env.GENERATION_TIMEOUT_MS ?? "default",
      generationMaxTokens: process.env.GENERATION_MAX_TOKENS ?? "default",
    });

    const baselineHtml = await getBaselineHtml();
    logGenerateRoute("info", "baseline_loaded", {
      requestId,
      baselineChars: baselineHtml.length,
    });

    const generation = await generateHtmlWithHuggingFace({
      hfApiKey,
      modelId,
      provider,
      prompt: SHARED_PROMPT,
      baselineHtml,
      traceId: requestId,
    });
    logGenerateRoute("info", "generation_completed", {
      requestId,
      usedModel: generation.usedModel,
      usedProvider: generation.usedProvider,
      attempts: summarizeAttempts(generation.attempts),
      generatedChars: generation.html.length,
    });

    const entry = await upsertArtifact({
      modelId,
      label: deriveModelLabel(modelId),
      html: generation.html,
      promptVersion: PROMPT_VERSION,
      sourceType: "model",
      sourceRef: `huggingface:${modelId}:${generation.usedProvider}`,
      provider: "huggingface",
      vendor: inferVendorFromModelId(modelId),
    });
    logGenerateRoute("info", "request_succeeded", {
      requestId,
      modelId: entry.modelId,
      durationMs: Date.now() - requestStartedAt,
    });

    return NextResponse.json(
      {
        ok: true,
        entry,
        generation: {
          usedModel: generation.usedModel,
          usedProvider: generation.usedProvider,
          attempts: generation.attempts,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof HFGenerationError) {
      logGenerateRoute("warn", "request_failed_generation", {
        requestId,
        status: error.status,
        message: error.message,
        attempts: summarizeAttempts(error.attempts),
        durationMs: Date.now() - requestStartedAt,
      });
      return jsonError(error.message, error.status, {
        attempts: error.attempts,
      });
    }

    if (error instanceof ArtifactError) {
      logGenerateRoute("error", "request_failed_artifact", {
        requestId,
        status: error.status,
        message: error.message,
        durationMs: Date.now() - requestStartedAt,
      });
      return jsonError(error.message, error.status);
    }

    const unknownError = error as { name?: unknown; message?: unknown };
    logGenerateRoute("error", "request_failed_unknown", {
      requestId,
      name: typeof unknownError.name === "string" ? unknownError.name : "UnknownError",
      message:
        typeof unknownError.message === "string"
          ? unknownError.message
          : "Unknown generation failure.",
      durationMs: Date.now() - requestStartedAt,
    });

    return jsonError("Unable to generate artifact from Hugging Face.", 500);
  }
}
