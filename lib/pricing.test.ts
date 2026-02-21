import { describe, expect, it } from "vitest";

import type { GenerationResult } from "@/lib/generation-types";
import { applyPricingToGenerationResult, normalizeGenerationUsage, PRICING_VERSION } from "@/lib/pricing";

describe("normalizeGenerationUsage", () => {
  it("returns null when usage values are empty", () => {
    expect(
      normalizeGenerationUsage({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    ).toBeNull();
  });

  it("normalizes usage fields with cached input tokens", () => {
    expect(
      normalizeGenerationUsage({
        inputTokens: 1000,
        outputTokens: 400,
        totalTokens: 1300,
        cachedInputTokens: 200,
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 400,
      totalTokens: 1400,
      cachedInputTokens: 200,
    });
  });
});

describe("applyPricingToGenerationResult", () => {
  it("calculates exact-match pricing with cached input discount", () => {
    const result: GenerationResult = {
      html: "<!doctype html><html><body>ok</body></html>",
      usedModel: "gpt-5-mini",
      usedProvider: "openai",
      attempts: [
        {
          model: "gpt-5-mini",
          provider: "openai",
          status: "success",
          retryable: false,
          durationMs: 123,
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            cachedInputTokens: 200_000,
            totalTokens: 1_500_000,
          },
        },
      ],
    };

    const priced = applyPricingToGenerationResult("openai", result);

    expect(priced.attempts[0]?.cost).toMatchObject({
      currency: "USD",
      inputUsd: 0.2,
      outputUsd: 0.5,
      cachedInputUsd: 0.0125,
      totalUsd: 0.7125,
      pricingVersion: PRICING_VERSION,
      pricingMatchedModel: "gpt-5-mini",
    });
    expect(priced.cost?.totalUsd).toBe(0.7125);
  });

  it("matches prefix pricing for routed Hugging Face model ids", () => {
    const result: GenerationResult = {
      html: "<!doctype html><html><body>ok</body></html>",
      usedModel: "moonshotai/Kimi-K2-Instruct-0905:novita",
      usedProvider: "novita",
      attempts: [
        {
          model: "moonshotai/Kimi-K2-Instruct-0905:novita",
          provider: "novita",
          status: "success",
          retryable: false,
          durationMs: 450,
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            totalTokens: 2_000_000,
          },
        },
      ],
    };

    const priced = applyPricingToGenerationResult("huggingface", result);

    expect(priced.attempts[0]?.cost).toMatchObject({
      totalUsd: 3.2,
      pricingMatchedModel: "moonshotai/kimi-k2",
    });
    expect(priced.cost?.totalUsd).toBe(3.2);
  });

  it("returns null cost when model pricing is unknown", () => {
    const result: GenerationResult = {
      html: "<!doctype html><html><body>ok</body></html>",
      usedModel: "unknown/exp-model",
      usedProvider: "openai",
      attempts: [
        {
          model: "unknown/exp-model",
          provider: "openai",
          status: "success",
          retryable: false,
          durationMs: 333,
          usage: {
            inputTokens: 10_000,
            outputTokens: 20_000,
            totalTokens: 30_000,
          },
        },
      ],
    };

    const priced = applyPricingToGenerationResult("openai", result);

    expect(priced.attempts[0]?.cost).toBeNull();
    expect(priced.cost).toBeNull();
    expect(priced.usage).toEqual({
      inputTokens: 10_000,
      outputTokens: 20_000,
      totalTokens: 30_000,
    });
  });

  it("aggregates total usage and cost across multiple attempts", () => {
    const result: GenerationResult = {
      html: "<!doctype html><html><body>ok</body></html>",
      usedModel: "gpt-5-nano",
      usedProvider: "openai",
      attempts: [
        {
          model: "gpt-5-nano",
          provider: "openai",
          status: "error",
          retryable: true,
          durationMs: 1200,
        },
        {
          model: "gpt-5-nano",
          provider: "openai",
          status: "success",
          retryable: false,
          durationMs: 500,
          usage: {
            inputTokens: 200_000,
            outputTokens: 100_000,
            totalTokens: 300_000,
          },
        },
        {
          model: "gpt-5-nano",
          provider: "openai",
          status: "success",
          retryable: false,
          durationMs: 450,
          usage: {
            inputTokens: 100_000,
            outputTokens: 50_000,
            totalTokens: 150_000,
          },
        },
      ],
    };

    const priced = applyPricingToGenerationResult("openai", result);

    expect(priced.usage).toEqual({
      inputTokens: 300_000,
      outputTokens: 150_000,
      totalTokens: 450_000,
    });
    expect(priced.cost).toMatchObject({
      currency: "USD",
      inputUsd: 0.015,
      outputUsd: 0.03,
      totalUsd: 0.045,
      pricingMatchedModel: "gpt-5-nano",
    });
  });
});
