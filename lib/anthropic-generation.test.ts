// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateHtmlWithAnthropic } from "@/lib/anthropic-generation";

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
});
