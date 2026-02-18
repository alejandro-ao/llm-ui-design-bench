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
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function deriveModelLabel(modelId: string): string {
  const tokens = modelId.split("/").filter(Boolean);
  const fallback = tokens.at(-1) ?? modelId;
  return fallback.slice(0, 120);
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
    const modelId = payload.modelId?.trim();

    if (!hfApiKey) {
      return jsonError("Hugging Face API key is required.", 400);
    }

    if (!modelId) {
      return jsonError("Model ID is required.", 400);
    }

    const baselineHtml = await getBaselineHtml();

    const generatedHtml = await generateHtmlWithHuggingFace({
      hfApiKey,
      modelId,
      prompt: SHARED_PROMPT,
      baselineHtml,
    });

    const entry = await upsertArtifact({
      modelId,
      label: deriveModelLabel(modelId),
      html: generatedHtml,
      promptVersion: PROMPT_VERSION,
      sourceType: "model",
      sourceRef: `huggingface:${modelId}`,
      provider: "huggingface",
      vendor: inferVendorFromModelId(modelId),
    });

    return NextResponse.json(
      {
        ok: true,
        entry,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof HFGenerationError) {
      return jsonError(error.message, error.status);
    }

    if (error instanceof ArtifactError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unable to generate artifact from Hugging Face.", 500);
  }
}
