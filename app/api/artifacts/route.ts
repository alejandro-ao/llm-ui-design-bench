import { NextRequest, NextResponse } from "next/server";

import {
  ArtifactError,
  getArtifactByModelId,
  listManifestEntries,
  type ArtifactManifestEntry,
  upsertArtifact,
} from "@/lib/artifacts";
import { getModelConfig } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ArtifactListItem {
  modelId: string;
  label: string;
  artifactPath: string;
  promptVersion: string;
  createdAt: string;
  sourceType: "model" | "agent" | "baseline";
  sourceRef?: string;
  provider: string;
  vendor: string;
}

function toListItem(entry: ArtifactManifestEntry): ArtifactListItem {
  if (entry.sourceType === "baseline") {
    return {
      ...entry,
      provider: "reference",
      vendor: "baseline",
    };
  }

  const model = getModelConfig(entry.modelId);

  return {
    ...entry,
    provider: model?.provider ?? "custom",
    vendor: model?.vendor ?? "unknown",
  };
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const modelId = request.nextUrl.searchParams.get("modelId");

  try {
    if (modelId) {
      const artifact = await getArtifactByModelId(modelId);

      if (!artifact) {
        return jsonError("Artifact not found.", 404);
      }

      return NextResponse.json({
        entry: toListItem(artifact.entry),
        html: artifact.html,
      });
    }

    const entries = await listManifestEntries();

    return NextResponse.json({
      entries: entries.map((entry) => toListItem(entry)),
    });
  } catch (error) {
    if (error instanceof ArtifactError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unexpected artifact service error.", 500);
  }
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;

    const entry = await upsertArtifact({
      modelId: String(payload.modelId ?? ""),
      label: String(payload.label ?? ""),
      html: String(payload.html ?? ""),
      promptVersion: String(payload.promptVersion ?? ""),
      sourceType: String(payload.sourceType ?? "") as "model" | "agent" | "baseline",
      sourceRef: payload.sourceRef ? String(payload.sourceRef) : undefined,
    });

    return NextResponse.json(
      {
        ok: true,
        modelId: entry.modelId,
        artifactPath: entry.artifactPath,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ArtifactError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unable to ingest artifact.", 500);
  }
}
