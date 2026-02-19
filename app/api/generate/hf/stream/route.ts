import { promises as fs } from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { ArtifactError, getArtifactByModelId } from "@/lib/artifacts";
import { HfCredentialError, resolveHfApiKeyFromRequest } from "@/lib/hf-auth";
import {
  buildHfAttemptPlan,
  generateHtmlWithHuggingFaceStreamed,
  HFGenerationError,
} from "@/lib/hf-generation";
import type {
  HfGenerationStreamAttemptPayload,
  HfGenerationStreamCompletePayload,
  HfGenerationStreamErrorPayload,
  HfGenerationStreamLogPayload,
  HfGenerationStreamMetaPayload,
  HfGenerationStreamTokenPayload,
  HfGenerationStreamEventName,
} from "@/lib/hf-stream-events";
import { inferVendorFromModelId } from "@/lib/models";
import {
  buildPromptWithSkill,
  MAX_SKILL_CONTENT_CHARS,
  SHARED_PROMPT,
} from "@/lib/prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GeneratePayload {
  hfApiKey?: string;
  modelId?: string;
  provider?: string;
  billTo?: string;
  skillContent?: string;
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

function logGenerateStreamRoute(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  if (level === "info") {
    console.info(`[api/generate/hf/stream] ${event}`, fields);
    return;
  }

  if (level === "warn") {
    console.warn(`[api/generate/hf/stream] ${event}`, fields);
    return;
  }

  console.error(`[api/generate/hf/stream] ${event}`, fields);
}

function deriveModelLabel(modelId: string): string {
  const tokens = modelId.split("/").filter(Boolean);
  const fallback = tokens.at(-1) ?? modelId;
  return fallback.slice(0, 120);
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
    const rawHfApiKey = payload.hfApiKey?.trim();
    const modelInput = payload.modelId?.trim();
    const billTo = payload.billTo?.trim();
    const normalizedSkillContent = payload.skillContent?.trim();

    if (!modelInput) {
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
    const hfApiKey = resolveHfApiKeyFromRequest(request, rawHfApiKey);
    const baselineHtml = await getBaselineHtml();
    const prompt = buildPromptWithSkill(SHARED_PROMPT, normalizedSkillContent);
    const plannedAttempts = buildHfAttemptPlan(modelId, provider);
    const encoder = new TextEncoder();

    logGenerateStreamRoute("info", "request_validated", {
      modelId,
      provider: provider ?? "auto",
      generationTimeoutMs: process.env.GENERATION_TIMEOUT_MS ?? "default",
      generationMaxTokens: process.env.GENERATION_MAX_TOKENS ?? "default",
      hasSkill: Boolean(normalizedSkillContent),
      skillChars: normalizedSkillContent?.length ?? 0,
    });

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
              modelId,
              provider: provider ?? null,
              plannedAttempts: plannedAttempts.length,
            });

            const generation = await generateHtmlWithHuggingFaceStreamed({
              hfApiKey,
              modelId,
              provider,
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
                modelId,
                label: deriveModelLabel(modelId),
                provider: "huggingface",
                vendor: inferVendorFromModelId(modelId),
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
            if (error instanceof HFGenerationError) {
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
              message: "Unable to generate output from Hugging Face.",
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
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof HfCredentialError) {
      return jsonError(error.message, error.status);
    }

    if (error instanceof ArtifactError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unable to start streaming generation.", 500);
  }
}
