import { promises as fs } from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { ArtifactError, getArtifactByModelId } from "@/lib/artifacts";
import {
  generateHtmlStreamed,
  GenerationError,
} from "@/lib/generation";
import type {
  HfGenerationStreamAttemptPayload,
  HfGenerationStreamCompletePayload,
  HfGenerationStreamErrorPayload,
  HfGenerationStreamEventName,
  HfGenerationStreamLogPayload,
  HfGenerationStreamMetaPayload,
  HfGenerationStreamTokenPayload,
} from "@/lib/hf-stream-events";
import { inferVendorFromModelId } from "@/lib/models";
import {
  ProviderCredentialError,
  resolveProviderApiKeyFromRequest,
} from "@/lib/provider-auth";
import {
  buildPromptWithSkill,
  MAX_SKILL_CONTENT_CHARS,
} from "@/lib/prompt";
import { isProviderId, type ProviderId } from "@/lib/providers";
import {
  buildTaskPrompt,
  getTaskDefinition,
  resolveTaskRequest,
  TaskValidationError,
} from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GeneratePayload {
  provider?: string;
  hfApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  modelId?: string;
  providerHint?: string;
  providerCandidates?: string[];
  billTo?: string;
  skillContent?: string;
  taskId?: string;
  taskContext?: unknown;
}

type StreamEventPayload =
  | HfGenerationStreamMetaPayload
  | HfGenerationStreamAttemptPayload
  | HfGenerationStreamTokenPayload
  | HfGenerationStreamLogPayload
  | HfGenerationStreamCompletePayload
  | HfGenerationStreamErrorPayload
  | Record<string, never>;

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

function parseProvider(providerInput: string | undefined): ProviderId {
  const normalized = providerInput?.trim().toLowerCase();
  if (!normalized || !isProviderId(normalized)) {
    throw new ArtifactError("provider is invalid.", 400);
  }

  return normalized;
}

function parseHfModelAndProvider(
  modelInput: string,
  providerHintInput: string | undefined,
): { modelId: string; providerHint?: string } {
  const trimmedModel = modelInput.trim();
  const trimmedProviderHint = providerHintInput?.trim();

  if (!trimmedModel) {
    throw new ArtifactError("Model ID is required.", 400);
  }

  let modelId = trimmedModel;
  let providerHint = trimmedProviderHint;

  const suffixIndex = trimmedModel.lastIndexOf(":");
  if (suffixIndex > 0 && suffixIndex < trimmedModel.length - 1) {
    modelId = trimmedModel.slice(0, suffixIndex).trim();
    providerHint = trimmedModel.slice(suffixIndex + 1).trim();
  }

  if (!modelId) {
    throw new ArtifactError("Model ID is required.", 400);
  }

  if (providerHint && !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(providerHint)) {
    throw new ArtifactError("Provider format is invalid.", 400);
  }

  return { modelId, providerHint: providerHint?.toLowerCase() };
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

function validateProviderSpecificOptions(
  provider: ProviderId,
  payload: GeneratePayload,
): void {
  if (provider === "huggingface") {
    return;
  }

  if (payload.providerHint?.trim()) {
    throw new ArtifactError("providerHint is supported only for Hugging Face.", 400);
  }

  if (payload.providerCandidates?.length) {
    throw new ArtifactError("providerCandidates are supported only for Hugging Face.", 400);
  }

  if (payload.billTo?.trim()) {
    throw new ArtifactError("billTo is supported only for Hugging Face.", 400);
  }
}

function deriveModelLabel(modelId: string): string {
  const tokens = modelId.split("/").filter(Boolean);
  const fallback = tokens.at(-1) ?? modelId;
  return fallback.slice(0, 120);
}

function resolveVendor(provider: ProviderId, modelId: string): string {
  if (provider === "huggingface") {
    return inferVendorFromModelId(modelId);
  }

  return provider;
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

function encodeSseEvent(event: HfGenerationStreamEventName, payload: StreamEventPayload): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildAttemptStartMessage(
  attempt: HfGenerationStreamAttemptPayload,
): string {
  return `Starting attempt ${attempt.attemptNumber}/${attempt.totalAttempts} with ${attempt.model}.`;
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const payload = (await request.json()) as GeneratePayload;

    const provider = parseProvider(payload.provider);
    const modelInput = payload.modelId?.trim();
    const billTo = payload.billTo?.trim();
    const normalizedSkillContent = payload.skillContent?.trim();
    const { taskId, taskContext } = resolveTaskRequest(payload.taskId, payload.taskContext);
    const taskDefinition = getTaskDefinition(taskId);

    if (!modelInput) {
      return jsonError("Model ID is required.", 400);
    }

    validateProviderSpecificOptions(provider, payload);

    if (billTo && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(billTo)) {
      return jsonError("Bill To format is invalid.", 400);
    }

    if (normalizedSkillContent && normalizedSkillContent.length > MAX_SKILL_CONTENT_CHARS) {
      return jsonError(
        `skillContent must be ${MAX_SKILL_CONTENT_CHARS} characters or fewer.`,
        400,
      );
    }

    const hfRouting =
      provider === "huggingface"
        ? parseHfModelAndProvider(modelInput, payload.providerHint)
        : { modelId: modelInput, providerHint: undefined };

    const providerCandidates =
      provider === "huggingface"
        ? parseProviderCandidates(payload.providerCandidates)
        : [];

    const apiKey = resolveProviderApiKeyFromRequest({
      request,
      provider,
      hfApiKey: payload.hfApiKey,
      openaiApiKey: payload.openaiApiKey,
      anthropicApiKey: payload.anthropicApiKey,
      googleApiKey: payload.googleApiKey,
    });

    const baselineHtml = taskDefinition.usesBaselineArtifact ? await getBaselineHtml() : "";
    const basePrompt = buildTaskPrompt(taskId, taskContext);
    const prompt = buildPromptWithSkill(basePrompt, normalizedSkillContent);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (event: HfGenerationStreamEventName, data: StreamEventPayload) => {
          controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
        };

        const close = () => {
          enqueue("done", {});
          controller.close();
        };

        void (async () => {
          try {
            enqueue("meta", {
              taskId,
              modelId: hfRouting.modelId,
              provider: provider === "huggingface" ? hfRouting.providerHint ?? null : provider,
              plannedAttempts:
                provider === "huggingface" && providerCandidates.length > 0
                  ? providerCandidates.length + 1
                  : hfRouting.providerHint
                    ? 2
                    : 1,
            });

            const generation = await generateHtmlStreamed({
              provider,
              apiKey,
              modelId: hfRouting.modelId,
              providerHint: hfRouting.providerHint,
              providerCandidates: providerCandidates.length > 0 ? providerCandidates : undefined,
              billTo: billTo || undefined,
              prompt,
              baselineHtml,
              onAttempt: async (attempt) => {
                enqueue("attempt", attempt);
                enqueue("log", {
                  message: buildAttemptStartMessage(attempt),
                });
              },
              onToken: async (token) => {
                enqueue("token", { text: token });
              },
              onLog: async (message) => {
                enqueue("log", { message });
              },
            });

            enqueue("log", {
              message: "Model output received for this session.",
            });

            enqueue("complete", {
              result: {
                modelId: hfRouting.modelId,
                label: deriveModelLabel(hfRouting.modelId),
                provider,
                vendor: resolveVendor(provider, hfRouting.modelId),
                html: generation.html,
              },
              generation: {
                usedModel: generation.usedModel,
                usedProvider: generation.usedProvider,
                attempts: generation.attempts,
              },
            });

            close();
          } catch (error) {
            if (error instanceof GenerationError) {
              enqueue("error", {
                message: error.message,
                attempts: error.attempts,
              });
              close();
              return;
            }

            if (error instanceof ArtifactError) {
              enqueue("error", {
                message: error.message,
                attempts: [],
              });
              close();
              return;
            }

            enqueue("error", {
              message: "Unable to generate output from provider.",
              attempts: [],
            });
            close();
          }
        })();
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof ProviderCredentialError) {
      return jsonError(error.message, error.status);
    }

    if (error instanceof TaskValidationError) {
      return jsonError(error.message, 400);
    }

    if (error instanceof ArtifactError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unable to start generation stream.", 500);
  }
}
