import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { ArtifactError, getArtifactByModelId } from "@/lib/artifacts";
import { HfCredentialError, resolveHfApiKeyFromRequest } from "@/lib/hf-auth";
import {
  generateHtmlWithHuggingFace,
  HFGenerationError,
  type HfGenerationAttempt,
} from "@/lib/hf-generation";
import { inferVendorFromModelId } from "@/lib/models";
import { applyPricingToGenerationResult } from "@/lib/pricing";
import {
  buildPromptWithSkill,
  MAX_SKILL_CONTENT_CHARS,
} from "@/lib/prompt";
import {
  buildTaskPrompt,
  getTaskDefinition,
  resolveTaskRequest,
  TaskValidationError,
} from "@/lib/tasks";
import { buildTaskReferenceImage } from "@/lib/task-reference-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GeneratePayload {
  hfApiKey?: string;
  modelId?: string;
  provider?: string;
  providers?: string[];
  billTo?: string;
  skillContent?: string;
  taskId?: string;
  taskContext?: unknown;
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

function parseProviderCandidates(providerInputs: string[] | undefined): string[] {
  if (!providerInputs?.length) {
    return [];
  }

  const unique = new Set<string>();

  for (const rawProvider of providerInputs) {
    const provider = rawProvider.trim().toLowerCase();
    if (!provider || provider === "auto") {
      continue;
    }

    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
      throw new ArtifactError("Provider format is invalid.", 400);
    }

    unique.add(provider);
    if (unique.size >= 8) {
      break;
    }
  }

  return [...unique];
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
  let requestedTaskId = "html_redesign";
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
    requestedTaskId = typeof payload.taskId === "string" ? payload.taskId : "html_redesign";

    const rawHfApiKey = payload.hfApiKey?.trim();
    const modelInput = payload.modelId?.trim();
    const billTo = payload.billTo?.trim();
    const normalizedSkillContent = payload.skillContent?.trim();
    const { taskId, taskContext } = resolveTaskRequest(payload.taskId, payload.taskContext);
    const taskDefinition = getTaskDefinition(taskId);

    if (!modelInput) {
      logGenerateRoute("warn", "request_rejected_missing_model_id", {
        requestId,
      });
      return jsonError("Model ID is required.", 400);
    }

    if (billTo && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(billTo)) {
      return jsonError("Bill To format is invalid.", 400);
    }

    if (normalizedSkillContent && normalizedSkillContent.length > MAX_SKILL_CONTENT_CHARS) {
      return jsonError(
        `skillContent must be ${MAX_SKILL_CONTENT_CHARS} characters or fewer.`,
        400,
      );
    }

    const { modelId, provider } = parseModelAndProvider(modelInput, payload.provider);
    const providers = parseProviderCandidates(payload.providers);
    const hfApiKey = resolveHfApiKeyFromRequest(request, rawHfApiKey);
    const basePrompt = buildTaskPrompt(taskId, taskContext);
    const prompt = buildPromptWithSkill(basePrompt, normalizedSkillContent);
    logGenerateRoute("info", "request_validated", {
      requestId,
      taskId,
      modelId,
      provider: provider ?? "auto",
      providerCandidates: providers,
      generationTimeoutMs: process.env.GENERATION_TIMEOUT_MS ?? "default",
      generationMaxTokens: process.env.GENERATION_MAX_TOKENS ?? "default",
      hasSkill: Boolean(normalizedSkillContent),
      skillChars: normalizedSkillContent?.length ?? 0,
    });

    const baselineHtml = taskDefinition.usesBaselineArtifact ? await getBaselineHtml() : "";
    let referenceImage = null;

    try {
      referenceImage = await buildTaskReferenceImage(taskId, taskContext);
    } catch (error) {
      logGenerateRoute("warn", "reference_image_unavailable", {
        requestId,
        taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    logGenerateRoute("info", "baseline_loaded", {
      requestId,
      taskId,
      baselineChars: baselineHtml.length,
    });

    const generation = await generateHtmlWithHuggingFace({
      hfApiKey,
      modelId,
      provider,
      providers: providers.length > 0 ? providers : undefined,
      billTo: billTo || undefined,
      prompt,
      baselineHtml,
      referenceImage: referenceImage ?? undefined,
      traceId: requestId,
    });
    const pricedGeneration = applyPricingToGenerationResult("huggingface", generation);
    logGenerateRoute("info", "generation_completed", {
      requestId,
      taskId,
      usedModel: pricedGeneration.usedModel,
      usedProvider: pricedGeneration.usedProvider,
      attempts: summarizeAttempts(pricedGeneration.attempts),
      generatedChars: pricedGeneration.html.length,
    });

    const result = {
      modelId,
      label: deriveModelLabel(modelId),
      provider: "huggingface" as const,
      vendor: inferVendorFromModelId(modelId),
      html: pricedGeneration.html,
    };
    logGenerateRoute("info", "request_succeeded", {
      requestId,
      taskId,
      modelId: result.modelId,
      durationMs: Date.now() - requestStartedAt,
    });

    return NextResponse.json(
      {
        ok: true,
        result,
        generation: {
          usedModel: pricedGeneration.usedModel,
          usedProvider: pricedGeneration.usedProvider,
          attempts: pricedGeneration.attempts,
          usage: pricedGeneration.usage ?? null,
          cost: pricedGeneration.cost ?? null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof HfCredentialError) {
      logGenerateRoute("warn", "request_rejected_auth", {
        requestId,
        status: error.status,
        message: error.message,
        durationMs: Date.now() - requestStartedAt,
      });
      return jsonError(error.message, error.status);
    }

    if (error instanceof HFGenerationError) {
      logGenerateRoute("warn", "request_failed_generation", {
        requestId,
        taskId: requestedTaskId,
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
        taskId: requestedTaskId,
        status: error.status,
        message: error.message,
        durationMs: Date.now() - requestStartedAt,
      });
      return jsonError(error.message, error.status);
    }

    if (error instanceof TaskValidationError) {
      logGenerateRoute("warn", "request_rejected_task_context", {
        requestId,
        taskId: requestedTaskId,
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

    return jsonError("Unable to generate output from Hugging Face.", 500);
  }
}
