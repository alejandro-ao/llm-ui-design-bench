import { promises as fs } from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { ArtifactError, getArtifactByModelId, upsertArtifact } from "@/lib/artifacts";
import { generateHtmlWithHuggingFace, HFGenerationError } from "@/lib/hf-generation";
import { inferVendorFromModelId } from "@/lib/models";
import { PROMPT_VERSION, SHARED_PROMPT } from "@/lib/prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GeneratePayload {
  hfApiKey?: string;
  modelId?: string;
  provider?: string;
  billTo?: string;
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
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const payload = (await request.json()) as GeneratePayload;

    const hfApiKey = payload.hfApiKey?.trim();
    const modelInput = payload.modelId?.trim();
    const billTo = payload.billTo?.trim();

    if (!hfApiKey) {
      return jsonError("Hugging Face API key is required.", 400);
    }

    if (!modelInput) {
      return jsonError("Model ID is required.", 400);
    }

    if (billTo && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(billTo)) {
      return jsonError("Bill To format is invalid.", 400);
    }

    const { modelId, provider } = parseModelAndProvider(modelInput, payload.provider);

    const baselineHtml = await getBaselineHtml();

    const generation = await generateHtmlWithHuggingFace({
      hfApiKey,
      modelId,
      provider,
      billTo: billTo || undefined,
      prompt: SHARED_PROMPT,
      baselineHtml,
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
      return jsonError(error.message, error.status, {
        attempts: error.attempts,
      });
    }

    if (error instanceof ArtifactError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unable to generate artifact from Hugging Face.", 500);
  }
}
