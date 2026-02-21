// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateHtmlWithAnthropic,
  generateHtmlWithAnthropicStreamed,
} from "@/lib/anthropic-generation";

describe("generateHtmlWithAnthropic", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.GENERATION_MAX_TOKENS;
  });

  function mockAnthropicSuccess() {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "<!doctype html><html><body>anthropic ok</body></html>",
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 200,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );
  }

  function encodeSseEvent(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  function mockAnthropicStream(events: string[]) {
    const streamText = events.join("");
    const splitOne = Math.floor(streamText.length / 3);
    const splitTwo = Math.floor((streamText.length * 2) / 3);

    const chunks = [
      streamText.slice(0, splitOne),
      streamText.slice(splitOne, splitTwo),
      streamText.slice(splitTwo),
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
    );
  }

  it("uses a 32768 default max_tokens budget", async () => {
    mockAnthropicSuccess();

    await generateHtmlWithAnthropic({
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-20250514",
      prompt: "Build a modern landing page.",
      baselineHtml: "<!doctype html><html><body>baseline</body></html>",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as { max_tokens?: number };
    expect(body.max_tokens).toBe(32768);
  });

  it("respects GENERATION_MAX_TOKENS without clamping to 8192", async () => {
    process.env.GENERATION_MAX_TOKENS = "12000";
    mockAnthropicSuccess();

    await generateHtmlWithAnthropic({
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-20250514",
      prompt: "Build a modern landing page.",
      baselineHtml: "<!doctype html><html><body>baseline</body></html>",
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as { max_tokens?: number };
    expect(body.max_tokens).toBe(12000);
  });

  it("streams Anthropic token deltas incrementally", async () => {
    const streamedTokens: string[] = [];
    mockAnthropicStream([
      encodeSseEvent("message_start", {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 111,
            output_tokens: 0,
          },
        },
      }),
      encodeSseEvent("content_block_start", {
        type: "content_block_start",
        content_block: {
          type: "text",
          text: "<!doctype html><html><body>",
        },
      }),
      encodeSseEvent("content_block_delta", {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Hello",
        },
      }),
      encodeSseEvent("content_block_delta", {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: " world",
        },
      }),
      encodeSseEvent("content_block_delta", {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "</body></html>",
        },
      }),
      encodeSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
        },
        usage: {
          output_tokens: 22,
        },
      }),
      encodeSseEvent("message_stop", {
        type: "message_stop",
      }),
    ]);

    const result = await generateHtmlWithAnthropicStreamed({
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-20250514",
      prompt: "Build a modern landing page.",
      baselineHtml: "<!doctype html><html><body>baseline</body></html>",
      onToken: async (token) => {
        streamedTokens.push(token);
      },
    });

    expect(streamedTokens).toEqual([
      "<!doctype html><html><body>",
      "Hello",
      " world",
      "</body></html>",
    ]);
    expect(result.html).toContain("<body>Hello world</body>");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.usage).toEqual({
      inputTokens: 111,
      outputTokens: 22,
      totalTokens: 133,
    });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as {
      stream?: boolean;
      max_tokens?: number;
    };
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(32768);
  });

  it("fails streamed generation when Anthropic stops on max_tokens before closing html", async () => {
    mockAnthropicStream([
      encodeSseEvent("message_start", {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 90,
            output_tokens: 0,
          },
        },
      }),
      encodeSseEvent("content_block_start", {
        type: "content_block_start",
        content_block: {
          type: "text",
          text: "<!doctype html><html><body>",
        },
      }),
      encodeSseEvent("content_block_delta", {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "incomplete output",
        },
      }),
      encodeSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: "max_tokens",
        },
        usage: {
          output_tokens: 8192,
        },
      }),
      encodeSseEvent("message_stop", {
        type: "message_stop",
      }),
    ]);

    await expect(
      generateHtmlWithAnthropicStreamed({
        apiKey: "sk-ant-test",
        modelId: "claude-sonnet-4-20250514",
        prompt: "Build a modern landing page.",
        baselineHtml: "<!doctype html><html><body>baseline</body></html>",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("max_tokens"),
      attempts: [
        expect.objectContaining({
          status: "error",
          provider: "anthropic",
        }),
      ],
    });
  });
});
