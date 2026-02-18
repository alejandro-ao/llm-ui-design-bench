// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

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
  it("returns parsed html from Hugging Face chat response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "```html\n<!doctype html><html><body>generated</body></html>\n```",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const html = await generateHtmlWithHuggingFace({
      hfApiKey: "hf_test_key",
      modelId: "moonshotai/kimi-k2",
      prompt: "Improve design",
      baselineHtml: "<html><body>baseline</body></html>",
    });

    expect(html).toContain("generated");
  });
});
