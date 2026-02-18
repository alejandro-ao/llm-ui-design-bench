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
  generateHtmlWithHuggingFaceStreamed,
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
        maxRetries: 0,
      }),
    );
    expect(request.model).toBe("moonshotai/kimi-k2:novita");
    expect(request).not.toHaveProperty("max_tokens");
    expect(result.html).toContain("generated");
    expect(result.usedProvider).toBe("novita");
    expect(result.attempts).toHaveLength(1);
  });

  it("retries provider timeouts and falls back to auto routing", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    completionCreateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Gateway timeout"), {
          status: 504,
        }),
      )
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

    vi.useFakeTimers();
    const generationPromise = generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });

    await vi.advanceTimersByTimeAsync(4000);
    const result = await generationPromise;
    randomSpy.mockRestore();

    const firstCall = completionCreateMock.mock.calls[0]?.[0] as {
      model: string;
      max_tokens?: number;
    };
    const secondCall = completionCreateMock.mock.calls[1]?.[0] as {
      model: string;
      max_tokens?: number;
    };
    const thirdCall = completionCreateMock.mock.calls[2]?.[0] as {
      model: string;
      max_tokens?: number;
    };

    expect(firstCall.model).toBe("moonshotai/kimi-k2:novita");
    expect(secondCall.model).toBe("moonshotai/kimi-k2:novita");
    expect(thirdCall.model).toBe("moonshotai/kimi-k2");
    expect(firstCall).not.toHaveProperty("max_tokens");
    expect(secondCall).not.toHaveProperty("max_tokens");
    expect(thirdCall).not.toHaveProperty("max_tokens");
    expect(result.usedProvider).toBe("auto");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]?.retryable).toBe(true);
    expect(result.attempts[1]?.retryable).toBe(true);
    expect(result.attempts[2]?.status).toBe("success");
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

    expect(request.model).toBe("MiniMaxAI/MiniMax-M2.5");
    expect(result.usedProvider).toBe("auto");
    expect(result.attempts).toHaveLength(1);
  });

  it("keeps timeout errors user-friendly without leaking HTML", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

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

    vi.useFakeTimers();
    const generationPromise = generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });
    const rejectionExpectation = expect(generationPromise).rejects.toMatchObject({
      name: "HFGenerationError",
      status: 504,
      message:
        "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
    });

    await vi.advanceTimersByTimeAsync(4000);
    await rejectionExpectation;
    randomSpy.mockRestore();
  });
});

describe("generateHtmlWithHuggingFaceStreamed", () => {
  beforeEach(() => {
    completionCreateMock.mockReset();
    constructorMock.mockReset();
    vi.useRealTimers();
    delete process.env.HF_BASE_URL;
  });

  it("streams token chunks and reconstructs html", async () => {
    completionCreateMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                content: "<!doctype html><html><body>streamed ",
              },
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                content: "content</body></html>",
              },
            },
          ],
        };
      },
    });

    const tokens: string[] = [];
    const attempts: Array<{ resetCode: boolean; model: string }> = [];

    const result = await generateHtmlWithHuggingFaceStreamed({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
      onToken: (token) => {
        tokens.push(token);
      },
      onAttempt: (attempt) => {
        attempts.push({ resetCode: attempt.resetCode, model: attempt.model });
      },
    });

    expect(tokens.join("")).toContain("streamed content");
    expect(result.html).toContain("streamed content");
    expect(result.attempts).toHaveLength(1);
    expect(attempts).toEqual([
      {
        resetCode: false,
        model: "moonshotai/kimi-k2:novita",
      },
    ]);
  });

  it("retries streaming attempts and marks retry resets", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    completionCreateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Gateway timeout"), {
          status: 504,
        }),
      )
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  content: "<!doctype html><html><body>retry success</body></html>",
                },
              },
            ],
          };
        },
      });

    const seenAttempts: boolean[] = [];
    vi.useFakeTimers();
    const generationPromise = generateHtmlWithHuggingFaceStreamed({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
      onAttempt: (attempt) => {
        seenAttempts.push(attempt.resetCode);
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await generationPromise;
    randomSpy.mockRestore();

    expect(result.html).toContain("retry success");
    expect(result.attempts).toHaveLength(2);
    expect(seenAttempts).toEqual([false, true]);
  });

  it("falls back to non-stream generation when streaming is unsupported", async () => {
    completionCreateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Streaming is not supported for this model."), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "<!doctype html><html><body>fallback non-stream</body></html>",
            },
          },
        ],
      });

    const tokens: string[] = [];

    const result = await generateHtmlWithHuggingFaceStreamed({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      provider: "novita",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
      onToken: (token) => {
        tokens.push(token);
      },
    });

    const firstCall = completionCreateMock.mock.calls[0]?.[0] as { stream?: boolean };
    const secondCall = completionCreateMock.mock.calls[1]?.[0] as { stream?: boolean };

    expect(firstCall.stream).toBe(true);
    expect(secondCall.stream).toBeUndefined();
    expect(tokens.at(-1)).toContain("fallback non-stream");
    expect(result.html).toContain("fallback non-stream");
    expect(result.attempts[0]?.detail).toContain("falling back");
  });
});
