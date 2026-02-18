// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { completionCreateMock, constructorMock } = vi.hoisted(() => ({
  completionCreateMock: vi.fn(),
  constructorMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: class {
    chat = {
      completions: {
        create: completionCreateMock,
      },
    };

    constructor(config: unknown) {
      constructorMock(config);
    }
  },
}));

import {
  extractHtmlDocument,
  generateHtmlWithHuggingFace,
  HFGenerationError,
} from "@/lib/hf-generation";

describe("extractHtmlDocument", () => {
  it("extracts html from fenced output", () => {
    const html = extractHtmlDocument("```html\n<!doctype html><html><body>ok</body></html>\n```");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<body>ok</body>");
  });

  it("throws when html is missing", () => {
    expect(() => extractHtmlDocument("hello world")).toThrow(HFGenerationError);
  });
});

describe("generateHtmlWithHuggingFace", () => {
  beforeEach(() => {
    completionCreateMock.mockReset();
    constructorMock.mockReset();
    vi.useRealTimers();
    delete process.env.HF_BASE_URL;
    delete process.env.GENERATION_TIMEOUT_MS;
    delete process.env.GENERATION_MAX_TOKENS;
  });

  it("returns parsed html and uses backward-compatible HF_BASE_URL parsing", async () => {
    process.env.HF_BASE_URL = "https://router.huggingface.co/v1/chat/completions";

    completionCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "```html\n<!doctype html><html><body>generated</body></html>\n```",
          },
        },
      ],
    });

    const result = await generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      billTo: "my-org",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });

    const request = completionCreateMock.mock.calls[0]?.[0] as {
      model: string;
      max_tokens?: number;
    };

    expect(constructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "hf_test_key",
        baseURL: "https://router.huggingface.co/v1",
        defaultHeaders: {
          "X-HF-Bill-To": "my-org",
        },
        maxRetries: 0,
      }),
    );
    const firstClientConfig = constructorMock.mock.calls[0]?.[0] as { timeout: number };
    expect(firstClientConfig.timeout).toBeLessThanOrEqual(1_200_000);
    expect(firstClientConfig.timeout).toBeGreaterThan(1_190_000);
    expect(request.model).toBe("moonshotai/kimi-k2:novita");
    expect(request.max_tokens).toBe(8192);
    expect(result.html).toContain("generated");
    expect(result.usedProvider).toBe("novita");
    expect(result.attempts).toHaveLength(1);
  });

  it("retries provider timeouts and falls back to auto routing", async () => {
    completionCreateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Gateway timeout"), {
          status: 504,
        }),
      )
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "<!doctype html><html><body>fallback success</body></html>",
            },
          },
        ],
      });

    const result = await generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });

    const firstCall = completionCreateMock.mock.calls[0]?.[0] as {
      model: string;
      max_tokens?: number;
    };
    const secondCall = completionCreateMock.mock.calls[1]?.[0] as {
      model: string;
      max_tokens?: number;
    };

    expect(firstCall.model).toBe("moonshotai/kimi-k2:novita");
    expect(secondCall.model).toBe("moonshotai/kimi-k2");
    expect(firstCall.max_tokens).toBe(8192);
    expect(secondCall.max_tokens).toBe(8192);
    expect(result.usedProvider).toBe("auto");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.retryable).toBe(true);
    expect(result.attempts[1]?.status).toBe("success");
  });

  it("does not retry non-retryable 404 errors", async () => {
    completionCreateMock.mockRejectedValue(
      Object.assign(new Error("Model not found"), {
        status: 404,
      }),
    );

    await expect(
      generateHtmlWithHuggingFace({
        hfApiKey: "hf_test_key",
        modelId: "moonshotai/kimi-k2",
        provider: "novita",
        prompt: "Improve design",
        baselineHtml: "<html><body>baseline</body></html>",
      }),
    ).rejects.toMatchObject({
      name: "HFGenerationError",
      status: 404,
      message: "Model ID or provider not found on Hugging Face inference providers.",
      attempts: [
        expect.objectContaining({
          model: "moonshotai/kimi-k2:novita",
          retryable: false,
        }),
      ],
    });

    expect(completionCreateMock).toHaveBeenCalledTimes(1);
  });

  it("uses auto routing when provider is omitted", async () => {
    completionCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "<!doctype html><html><body>auto route</body></html>",
          },
        },
      ],
    });

    const result = await generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "MiniMaxAI/MiniMax-M2.5",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });

    const request = completionCreateMock.mock.calls[0]?.[0] as { model: string };

    expect(constructorMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        defaultHeaders: expect.anything(),
      }),
    );
    expect(request.model).toBe("MiniMaxAI/MiniMax-M2.5");
    expect((request as { max_tokens?: number }).max_tokens).toBe(8192);
    expect(result.usedProvider).toBe("auto");
    expect(result.attempts).toHaveLength(1);
  });

  it("respects GENERATION_MAX_TOKENS override", async () => {
    process.env.GENERATION_MAX_TOKENS = "12000";
    completionCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "<!doctype html><html><body>token override</body></html>",
          },
        },
      ],
    });

    await generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });

    const request = completionCreateMock.mock.calls[0]?.[0] as { max_tokens?: number };
    expect(request.max_tokens).toBe(12000);
  });

  it("does not retry timeout errors when provider is omitted", async () => {
    completionCreateMock.mockRejectedValueOnce(
      Object.assign(new Error("Gateway timeout"), {
        status: 504,
      }),
    );

    await expect(
      generateHtmlWithHuggingFace({
        hfApiKey: "hf_test_key",
        modelId: "moonshotai/kimi-k2",
        prompt: "Improve design",
        baselineHtml: "<html><body>baseline</body></html>",
      }),
    ).rejects.toMatchObject({
      name: "HFGenerationError",
      status: 504,
      attempts: [
        expect.objectContaining({
          model: "moonshotai/kimi-k2",
          provider: "auto",
          retryable: false,
        }),
      ],
    });

    expect(completionCreateMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the total timeout budget is exhausted", async () => {
    process.env.GENERATION_TIMEOUT_MS = "1000";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    completionCreateMock.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:01.500Z"));
      throw Object.assign(new Error("Gateway timeout"), {
        status: 504,
      });
    });

    await expect(
      generateHtmlWithHuggingFace({
        hfApiKey: "hf_test_key",
        modelId: "moonshotai/kimi-k2",
        provider: "novita",
        prompt: "Improve design",
        baselineHtml: "<html><body>baseline</body></html>",
      }),
    ).rejects.toMatchObject({
      name: "HFGenerationError",
      status: 504,
      message: "Generation timed out before another provider attempt could start.",
      attempts: [
        expect.objectContaining({
          model: "moonshotai/kimi-k2:novita",
          retryable: true,
        }),
      ],
    });

    expect(completionCreateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps timeout errors user-friendly without leaking HTML", async () => {
    completionCreateMock.mockRejectedValue(
      Object.assign(
        new Error(
          "<!DOCTYPE html><html><head><title>Gateway Timeout</title></head><body>timeout</body></html>",
        ),
        {
          status: 504,
        },
      ),
    );

    await expect(
      generateHtmlWithHuggingFace({
        hfApiKey: "hf_test_key",
        modelId: "moonshotai/kimi-k2",
        provider: "novita",
        prompt: "Improve design",
        baselineHtml: "<html><body>baseline</body></html>",
      }),
    ).rejects.toMatchObject({
      name: "HFGenerationError",
      status: 504,
      message:
        "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
      attempts: [
        expect.objectContaining({
          model: "moonshotai/kimi-k2:novita",
        }),
        expect.objectContaining({
          model: "moonshotai/kimi-k2",
        }),
      ],
    });

    expect(completionCreateMock).toHaveBeenCalledTimes(2);
  });
});
