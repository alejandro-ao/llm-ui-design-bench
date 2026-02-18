import { NextRequest, NextResponse } from "next/server";

import { listModels } from "@huggingface/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchResultItem {
  modelId: string;
  label: string;
  vendor: string;
  providers: string[];
}

function normalizeLimit(rawLimit: string | null): number {
  const parsed = Number.parseInt(rawLimit ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }

  return Math.min(Math.max(parsed, 1), 20);
}

function getLabel(modelId: string): string {
  const tokens = modelId.split("/").filter(Boolean);
  return (tokens.at(-1) ?? modelId).slice(0, 120);
}

function getVendor(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex > 0) {
    return modelId.slice(0, slashIndex).toLowerCase();
  }

  return "unknown";
}

function normalizeProviders(providers: unknown): string[] {
  if (!Array.isArray(providers)) {
    return [];
  }

  const values = providers
    .map((provider) => {
      const normalized = provider as { provider?: unknown };
      return typeof normalized.provider === "string"
        ? normalized.provider.toLowerCase()
        : null;
    })
    .filter((provider): provider is string => Boolean(provider));

  return [...new Set(values)];
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const limit = normalizeLimit(request.nextUrl.searchParams.get("limit"));

  if (query.length < 2) {
    return NextResponse.json({
      models: [] as SearchResultItem[],
    });
  }

  const models: SearchResultItem[] = [];
  const remoteLimit = Math.min(limit * 3, 60);

  for await (const model of listModels({
    search: {
      query,
    },
    additionalFields: ["inferenceProviderMapping"],
    limit: remoteLimit,
    sort: "downloads",
  })) {
    const modelId = model.name;
    const providers = normalizeProviders(model.inferenceProviderMapping);

    if (!providers.length) {
      continue;
    }

    models.push({
      modelId,
      label: getLabel(modelId),
      vendor: getVendor(modelId),
      providers,
    });

    if (models.length >= limit) {
      break;
    }
  }

  return NextResponse.json({
    models,
  });
}
