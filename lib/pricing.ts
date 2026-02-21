import type {
  GenerationAttempt,
  GenerationCost,
  GenerationResult,
  GenerationUsage,
} from "@/lib/generation-types";
import type { ProviderId } from "@/lib/providers";

const TOKENS_PER_MILLION = 1_000_000;

// Update this when prices are refreshed from provider pricing pages.
export const PRICING_VERSION = "2026-02-21";

interface ModelPricingEntry {
  provider: ProviderId;
  matchType: "exact" | "prefix";
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  routingProviders?: string[];
}

interface ResolvedModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  pricingMatchedModel: string;
  pricingVersion: string;
}

const MODEL_PRICING_TABLE: ModelPricingEntry[] = [
  {
    provider: "openai",
    matchType: "exact",
    model: "gpt-5.2",
    inputUsdPer1M: 1.5,
    outputUsdPer1M: 6,
    cachedInputUsdPer1M: 0.375,
  },
  {
    provider: "openai",
    matchType: "exact",
    model: "gpt-5.1",
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.3125,
  },
  {
    provider: "openai",
    matchType: "exact",
    model: "gpt-5-mini",
    inputUsdPer1M: 0.25,
    outputUsdPer1M: 1,
    cachedInputUsdPer1M: 0.0625,
  },
  {
    provider: "openai",
    matchType: "exact",
    model: "gpt-5-nano",
    inputUsdPer1M: 0.05,
    outputUsdPer1M: 0.2,
    cachedInputUsdPer1M: 0.0125,
  },
  {
    provider: "openai",
    matchType: "exact",
    model: "gpt-4.1",
    inputUsdPer1M: 2,
    outputUsdPer1M: 8,
    cachedInputUsdPer1M: 0.5,
  },
  {
    provider: "anthropic",
    matchType: "exact",
    model: "claude-opus-4-6",
    inputUsdPer1M: 15,
    outputUsdPer1M: 75,
  },
  {
    provider: "anthropic",
    matchType: "exact",
    model: "claude-sonnet-4-6",
    inputUsdPer1M: 3,
    outputUsdPer1M: 15,
  },
  {
    provider: "anthropic",
    matchType: "exact",
    model: "claude-opus-4-1-20250805",
    inputUsdPer1M: 15,
    outputUsdPer1M: 75,
  },
  {
    provider: "anthropic",
    matchType: "exact",
    model: "claude-sonnet-4-20250514",
    inputUsdPer1M: 3,
    outputUsdPer1M: 15,
  },
  {
    provider: "anthropic",
    matchType: "exact",
    model: "claude-3-5-haiku-latest",
    inputUsdPer1M: 0.8,
    outputUsdPer1M: 4,
  },
  {
    provider: "google",
    matchType: "exact",
    model: "gemini-3-pro-preview",
    inputUsdPer1M: 3.5,
    outputUsdPer1M: 10.5,
  },
  {
    provider: "google",
    matchType: "exact",
    model: "gemini-3-flash-preview",
    inputUsdPer1M: 0.35,
    outputUsdPer1M: 1.05,
  },
  {
    provider: "google",
    matchType: "exact",
    model: "gemini-2.5-flash",
    inputUsdPer1M: 0.35,
    outputUsdPer1M: 1.05,
  },
  {
    provider: "huggingface",
    matchType: "prefix",
    model: "moonshotai/kimi-k2",
    inputUsdPer1M: 0.8,
    outputUsdPer1M: 2.4,
  },
  {
    provider: "huggingface",
    matchType: "prefix",
    model: "minimax/minimax-m1",
    inputUsdPer1M: 0.6,
    outputUsdPer1M: 2,
  },
  {
    provider: "huggingface",
    matchType: "prefix",
    model: "minimaxai/minimax-m2",
    inputUsdPer1M: 0.6,
    outputUsdPer1M: 2,
  },
  {
    provider: "huggingface",
    matchType: "prefix",
    model: "qwen/qwen",
    inputUsdPer1M: 0.3,
    outputUsdPer1M: 0.9,
  },
  {
    provider: "huggingface",
    matchType: "prefix",
    model: "deepseek-ai/deepseek",
    inputUsdPer1M: 0.55,
    outputUsdPer1M: 1.65,
  },
  {
    provider: "huggingface",
    matchType: "prefix",
    model: "meta-llama/llama-3.3-70b-instruct",
    inputUsdPer1M: 0.9,
    outputUsdPer1M: 0.9,
  },
];

function parseTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  if (normalized < 0) {
    return null;
  }

  return normalized;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function splitRoutedModelId(modelId: string): {
  baseModelId: string;
  routingProvider?: string;
} {
  const trimmed = modelId.trim();
  const suffixIndex = trimmed.lastIndexOf(":");
  if (suffixIndex > 0 && suffixIndex < trimmed.length - 1) {
    const baseModelId = trimmed.slice(0, suffixIndex).trim().toLowerCase();
    const routingProvider = trimmed.slice(suffixIndex + 1).trim().toLowerCase();
    return {
      baseModelId,
      routingProvider: routingProvider || undefined,
    };
  }

  return {
    baseModelId: trimmed.toLowerCase(),
  };
}

function isRoutingProviderMatch(
  entry: ModelPricingEntry,
  routingProvider: string | undefined,
): boolean {
  if (!entry.routingProviders?.length) {
    return true;
  }

  if (!routingProvider) {
    return false;
  }

  return entry.routingProviders.includes(routingProvider);
}

function resolveModelPricing(
  provider: ProviderId,
  modelId: string,
  routingProviderInput?: string,
): ResolvedModelPricing | null {
  const { baseModelId, routingProvider: routedFromModel } = splitRoutedModelId(modelId);
  if (!baseModelId) {
    return null;
  }

  const routingProvider = routingProviderInput?.trim().toLowerCase() || routedFromModel;

  const exactMatch = MODEL_PRICING_TABLE.find(
    (entry) =>
      entry.provider === provider &&
      entry.matchType === "exact" &&
      entry.model === baseModelId &&
      isRoutingProviderMatch(entry, routingProvider),
  );

  if (exactMatch) {
    return {
      inputUsdPer1M: exactMatch.inputUsdPer1M,
      outputUsdPer1M: exactMatch.outputUsdPer1M,
      cachedInputUsdPer1M: exactMatch.cachedInputUsdPer1M,
      pricingMatchedModel: exactMatch.model,
      pricingVersion: PRICING_VERSION,
    };
  }

  const prefixMatches = MODEL_PRICING_TABLE
    .filter(
      (entry) =>
        entry.provider === provider &&
        entry.matchType === "prefix" &&
        baseModelId.startsWith(entry.model) &&
        isRoutingProviderMatch(entry, routingProvider),
    )
    .sort((left, right) => right.model.length - left.model.length);

  const bestPrefix = prefixMatches[0];
  if (!bestPrefix) {
    return null;
  }

  return {
    inputUsdPer1M: bestPrefix.inputUsdPer1M,
    outputUsdPer1M: bestPrefix.outputUsdPer1M,
    cachedInputUsdPer1M: bestPrefix.cachedInputUsdPer1M,
    pricingMatchedModel: bestPrefix.model,
    pricingVersion: PRICING_VERSION,
  };
}

export function normalizeGenerationUsage(input: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cachedInputTokens?: unknown;
}): GenerationUsage | null {
  const inputTokens = parseTokenCount(input.inputTokens) ?? 0;
  const outputTokens = parseTokenCount(input.outputTokens) ?? 0;
  const totalTokensRaw = parseTokenCount(input.totalTokens);
  const cachedInputTokensRaw = parseTokenCount(input.cachedInputTokens);

  const hasAnyUsage =
    inputTokens > 0 ||
    outputTokens > 0 ||
    (totalTokensRaw !== null && totalTokensRaw > 0) ||
    (cachedInputTokensRaw !== null && cachedInputTokensRaw > 0);
  if (!hasAnyUsage) {
    return null;
  }

  const totalTokenFloor = inputTokens + outputTokens;
  const totalTokens = Math.max(totalTokensRaw ?? 0, totalTokenFloor);
  const cachedInputTokens =
    cachedInputTokensRaw !== null && cachedInputTokensRaw > 0
      ? Math.min(cachedInputTokensRaw, inputTokens)
      : undefined;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
  };
}

function calculateGenerationCost(
  usage: GenerationUsage,
  pricing: ResolvedModelPricing,
): GenerationCost {
  const cachedInputTokens =
    usage.cachedInputTokens && usage.cachedInputTokens > 0 ? usage.cachedInputTokens : 0;

  let uncachedInputTokens = usage.inputTokens;
  let cachedInputUsd: number | undefined;
  if (cachedInputTokens > 0 && typeof pricing.cachedInputUsdPer1M === "number") {
    uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
    cachedInputUsd = roundUsd((cachedInputTokens / TOKENS_PER_MILLION) * pricing.cachedInputUsdPer1M);
  }

  const inputUsd = roundUsd((uncachedInputTokens / TOKENS_PER_MILLION) * pricing.inputUsdPer1M);
  const outputUsd = roundUsd((usage.outputTokens / TOKENS_PER_MILLION) * pricing.outputUsdPer1M);
  const totalUsd = roundUsd(inputUsd + outputUsd + (cachedInputUsd ?? 0));

  return {
    currency: "USD",
    inputUsd,
    outputUsd,
    cachedInputUsd,
    totalUsd,
    pricingVersion: pricing.pricingVersion,
    pricingMatchedModel: pricing.pricingMatchedModel,
  };
}

function enrichAttemptCost(provider: ProviderId, attempt: GenerationAttempt): GenerationAttempt {
  if (!attempt.usage) {
    return attempt;
  }

  const pricing = resolveModelPricing(
    provider,
    attempt.model,
    provider === "huggingface" ? attempt.provider : undefined,
  );

  if (!pricing) {
    return {
      ...attempt,
      cost: null,
    };
  }

  return {
    ...attempt,
    cost: calculateGenerationCost(attempt.usage, pricing),
  };
}

function aggregateUsage(attempts: GenerationAttempt[]): GenerationUsage | null {
  const usageAttempts = attempts.filter((attempt) => Boolean(attempt.usage));
  if (usageAttempts.length === 0) {
    return null;
  }

  const totals = usageAttempts.reduce(
    (accumulator, attempt) => {
      const usage = attempt.usage as GenerationUsage;
      accumulator.inputTokens += usage.inputTokens;
      accumulator.outputTokens += usage.outputTokens;
      accumulator.totalTokens += usage.totalTokens;
      accumulator.cachedInputTokens += usage.cachedInputTokens ?? 0;
      return accumulator;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
    },
  );

  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    cachedInputTokens: totals.cachedInputTokens > 0 ? totals.cachedInputTokens : undefined,
  };
}

function aggregateCost(attempts: GenerationAttempt[]): GenerationCost | null {
  const attemptsWithUsage = attempts.filter((attempt) => Boolean(attempt.usage));
  if (attemptsWithUsage.length === 0) {
    return null;
  }

  const pricedAttempts = attemptsWithUsage.filter(
    (attempt): attempt is GenerationAttempt & { cost: GenerationCost } =>
      Boolean(attempt.cost),
  );
  if (pricedAttempts.length !== attemptsWithUsage.length) {
    return null;
  }

  const totals = pricedAttempts.reduce(
    (accumulator, attempt) => {
      const cost = attempt.cost;
      accumulator.inputUsd += cost.inputUsd;
      accumulator.outputUsd += cost.outputUsd;
      accumulator.cachedInputUsd += cost.cachedInputUsd ?? 0;
      accumulator.totalUsd += cost.totalUsd;
      accumulator.pricingMatchedModels.add(cost.pricingMatchedModel);
      accumulator.pricingVersions.add(cost.pricingVersion);
      return accumulator;
    },
    {
      inputUsd: 0,
      outputUsd: 0,
      cachedInputUsd: 0,
      totalUsd: 0,
      pricingMatchedModels: new Set<string>(),
      pricingVersions: new Set<string>(),
    },
  );

  return {
    currency: "USD",
    inputUsd: roundUsd(totals.inputUsd),
    outputUsd: roundUsd(totals.outputUsd),
    cachedInputUsd: totals.cachedInputUsd > 0 ? roundUsd(totals.cachedInputUsd) : undefined,
    totalUsd: roundUsd(totals.totalUsd),
    pricingVersion:
      totals.pricingVersions.size === 1
        ? [...totals.pricingVersions][0]!
        : `${PRICING_VERSION}-mixed`,
    pricingMatchedModel:
      totals.pricingMatchedModels.size === 1
        ? [...totals.pricingMatchedModels][0]!
        : "mixed",
  };
}

export function applyPricingToGenerationResult(
  provider: ProviderId,
  result: GenerationResult,
): GenerationResult {
  const attempts = result.attempts.map((attempt) => enrichAttemptCost(provider, attempt));
  const usage = aggregateUsage(attempts);
  const cost = aggregateCost(attempts);

  return {
    ...result,
    attempts,
    usage,
    cost,
  };
}
