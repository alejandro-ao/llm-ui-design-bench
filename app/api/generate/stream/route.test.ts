// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { generateStreamMock } = vi.hoisted(() => ({
  generateStreamMock: vi.fn(),
}));

vi.mock("@/lib/generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation")>();
  return {
    ...actual,
    generateHtmlStreamed: generateStreamMock,
  };
});

import { POST } from "@/app/api/generate/stream/route";

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generate-unified-stream-tests-"));
  await fs.mkdir(path.join(projectRoot, "data", "artifacts", "baseline"), {
    recursive: true,
  });

  await fs.writeFile(
    path.join(projectRoot, "data", "artifacts", "manifest.json"),
    JSON.stringify(
      [
        {
          modelId: "baseline",
          label: "Baseline",
          artifactPath: "data/artifacts/baseline/index.html",
          promptVersion: "v1",
          createdAt: "2026-02-18T00:00:00.000Z",
          sourceType: "baseline",
        },
      ],
      null,
      2,
    ),
    "utf8",
  );

  await fs.writeFile(
    path.join(projectRoot, "data", "artifacts", "baseline", "index.html"),
    "<!doctype html><html><body>baseline</body></html>",
    "utf8",
  );

  return projectRoot;
}

function extractSseEventPayload<T>(raw: string, eventName: string): T | null {
  const blocks = raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event:"));
    if (!eventLine || eventLine.replace("event:", "").trim() !== eventName) {
      continue;
    }

    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (!dataLines.length) {
      return null;
    }

    const json = dataLines.map((line) => line.slice("data:".length).trimStart()).join("\n");
    return JSON.parse(json) as T;
  }

  return null;
}

describe("POST /api/generate/stream", () => {
  beforeEach(() => {
    generateStreamMock.mockReset();
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 23).toString("base64url");
  });

  it("streams complete payload for OpenAI provider", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateStreamMock.mockImplementation(
      async (input: {
        onAttempt?: (value: unknown) => Promise<void> | void;
        onToken?: (value: string) => Promise<void> | void;
      }) => {
        await input.onAttempt?.({
          attemptNumber: 1,
          totalAttempts: 1,
          model: "gpt-4.1",
          provider: "openai",
          resetCode: false,
        });
        await input.onToken?.("<!doctype html><html><body>openai stream</body></html>");

        return {
          html: "<!doctype html><html><body>openai stream</body></html>",
          usedModel: "gpt-4.1",
          usedProvider: "openai",
          attempts: [
            {
              model: "gpt-4.1",
              provider: "openai",
              status: "success" as const,
              retryable: false,
              durationMs: 500,
            },
          ],
          usage: {
            inputTokens: 1100,
            outputTokens: 2100,
            totalTokens: 3200,
          },
          cost: {
            currency: "USD",
            inputUsd: 0.0022,
            outputUsd: 0.0168,
            totalUsd: 0.019,
            pricingVersion: "2026-02-21",
            pricingMatchedModel: "gpt-4.1",
          },
        };
      },
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          openaiApiKey: "sk_test_key",
          modelId: "gpt-4.1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const rawStream = await response.text();

    const completePayload = extractSseEventPayload<{
      result: {
        modelId: string;
        provider: string;
      };
      generation: {
        usedProvider: string;
        usage?: {
          totalTokens: number;
        } | null;
        cost?: {
          totalUsd: number;
        } | null;
      };
    }>(rawStream, "complete");

    expect(completePayload).toMatchObject({
      result: {
        modelId: "gpt-4.1",
        provider: "openai",
      },
      generation: {
        usedProvider: "openai",
        usage: {
          totalTokens: 3200,
        },
        cost: {
          totalUsd: 0.019,
        },
      },
    });
  });

  it("returns 400 when provider is missing", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelId: "gpt-4.1",
          openaiApiKey: "sk_test_key",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "provider is invalid.",
    });
  });

  it("returns 400 when Anthropic API key is missing", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "anthropic",
          modelId: "claude-3-7-sonnet-latest",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provide Anthropic API key.",
    });
  });

  it("forwards referenceImage for image_to_code stream requests", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateStreamMock.mockResolvedValue({
      html: "<!doctype html><html><body>image stream</body></html>",
      usedModel: "gpt-4.1",
      usedProvider: "openai",
      attempts: [
        {
          model: "gpt-4.1",
          provider: "openai",
          status: "success",
          retryable: false,
          durationMs: 520,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          openaiApiKey: "sk_test_key",
          modelId: "gpt-4.1",
          taskId: "image_to_code",
          taskContext: {
            imageId: "figma_landing",
            imageUrl: "http://localhost/task-assets/image-to-code/figma.png",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);

    const calledInput = generateStreamMock.mock.calls.at(-1)?.[0] as {
      referenceImage?: {
        mimeType: string;
        base64Data: string;
      };
      prompt: string;
    };
    expect(calledInput.prompt).toContain("Reference image URL: http://localhost/task-assets/image-to-code/figma.png");
    expect(calledInput.referenceImage).toMatchObject({
      mimeType: "image/png",
    });
    expect(calledInput.referenceImage?.base64Data).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
