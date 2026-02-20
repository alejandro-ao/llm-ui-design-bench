// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
}));

vi.mock("@/lib/generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation")>();
  return {
    ...actual,
    generateHtml: generateMock,
  };
});

import { POST } from "@/app/api/generate/route";
import { GenerationError } from "@/lib/generation";

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generate-unified-tests-"));
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

describe("POST /api/generate", () => {
  beforeEach(() => {
    generateMock.mockReset();
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 21).toString("base64url");
  });

  it("generates output for OpenAI with provider-specific API key", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>openai output</body></html>",
      usedModel: "gpt-4.1",
      usedProvider: "openai",
      attempts: [
        {
          model: "gpt-4.1",
          provider: "openai",
          status: "success",
          retryable: false,
          durationMs: 700,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate", {
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

    expect(response.status).toBe(201);

    const payload = (await response.json()) as {
      result: {
        modelId: string;
        provider: string;
        vendor: string;
      };
      generation: {
        usedProvider: string;
      };
    };

    expect(payload.result).toMatchObject({
      modelId: "gpt-4.1",
      provider: "openai",
      vendor: "openai",
    });
    expect(payload.generation.usedProvider).toBe("openai");
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "sk_test_key",
        modelId: "gpt-4.1",
      }),
    );
  });

  it("returns 400 when provider is missing", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate", {
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

  it("returns 400 when OpenAI key is missing", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          modelId: "gpt-4.1",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provide OpenAI API key.",
    });
  });

  it("rejects Hugging Face provider options for non-HF providers", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          googleApiKey: "AIza_test_key",
          modelId: "gemini-2.5-flash",
          providerCandidates: ["novita"],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "providerCandidates are supported only for Hugging Face.",
    });
  });

  it("returns normalized generation errors with attempts", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockRejectedValue(
      new GenerationError("OpenAI upstream failure.", 502, [
        {
          model: "gpt-4.1",
          provider: "openai",
          status: "error",
          statusCode: 502,
          retryable: false,
          durationMs: 600,
          detail: "OpenAI upstream failure.",
        },
      ]),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate", {
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

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "OpenAI upstream failure.",
      attempts: [
        {
          model: "gpt-4.1",
          provider: "openai",
          status: "error",
        },
      ],
    });
  });
});
