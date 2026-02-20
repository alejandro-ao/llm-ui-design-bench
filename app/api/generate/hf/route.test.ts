// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
}));

vi.mock("@/lib/hf-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hf-generation")>();
  return {
    ...actual,
    generateHtmlWithHuggingFace: generateMock,
  };
});

import { POST } from "@/app/api/generate/hf/route";
import { HFGenerationError, type HfGenerationAttempt } from "@/lib/hf-generation";
import {
  buildHfOAuthSessionPayload,
  sealHfOAuthSession,
} from "@/lib/hf-oauth-session";
import { MAX_SKILL_CONTENT_CHARS, SHARED_PROMPT } from "@/lib/prompt";

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generate-hf-tests-"));
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

describe("POST /api/generate/hf", () => {
  beforeEach(() => {
    generateMock.mockReset();
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 11).toString("base64url");
  });

  it("returns ephemeral generation output with metadata", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const attempts: HfGenerationAttempt[] = [
      {
        model: "moonshotai/kimi-k2-instruct:novita",
        provider: "novita",
        status: "success",
        retryable: false,
        durationMs: 1200,
      },
    ];

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>generated page</body></html>",
      usedModel: "moonshotai/kimi-k2-instruct:novita",
      usedProvider: "novita",
      attempts,
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          provider: "novita",
          billTo: "my-org",
        }),
      }),
    );

    expect(response.status).toBe(201);

    const payload = (await response.json()) as {
      ok: boolean;
      result: {
        modelId: string;
        label: string;
        provider: string;
        vendor: string;
        html: string;
      };
      generation: {
        usedModel: string;
        usedProvider: string;
        attempts: HfGenerationAttempt[];
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({
      modelId: "moonshotai/kimi-k2-instruct",
      label: "kimi-k2-instruct",
      provider: "huggingface",
      vendor: "moonshotai",
    });
    expect(payload.result.html).toContain("generated page");
    expect(payload.generation.usedProvider).toBe("novita");
    expect(payload.generation.attempts).toEqual(attempts);
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hfApiKey: "hf_test_key",
        modelId: "moonshotai/kimi-k2-instruct",
        provider: "novita",
        billTo: "my-org",
      }),
    );

    expect(payload).not.toHaveProperty("entry");
  });

  it("accepts skillContent and composes prompt context", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>generated page</body></html>",
      usedModel: "moonshotai/kimi-k2-instruct",
      usedProvider: "auto",
      attempts: [
        {
          model: "moonshotai/kimi-k2-instruct",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 900,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          skillContent: "  Use editorial typography and generous whitespace.  ",
        }),
      }),
    );

    expect(response.status).toBe(201);

    const calledInput = generateMock.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(calledInput.prompt).toContain(SHARED_PROMPT);
    expect(calledInput.prompt).toContain("Additional user-provided design skill");
    expect(calledInput.prompt).toContain("--- BEGIN USER SKILL ---");
    expect(calledInput.prompt).toContain("Use editorial typography and generous whitespace.");
    expect(calledInput.prompt).toContain("--- END USER SKILL ---");
  });

  it("accepts image_to_code task context and builds task-specific prompt", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>image task output</body></html>",
      usedModel: "moonshotai/kimi-k2-instruct",
      usedProvider: "auto",
      attempts: [
        {
          model: "moonshotai/kimi-k2-instruct",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 900,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          taskId: "image_to_code",
          taskContext: {
            imageId: "dashboard_a",
            imageUrl: "http://localhost/task-assets/image-to-code/dashboard-a.svg",
          },
        }),
      }),
    );

    expect(response.status).toBe(201);

    const calledInput = generateMock.mock.calls.at(-1)?.[0] as {
      prompt: string;
      baselineHtml: string;
    };
    expect(calledInput.baselineHtml).toBe("");
    expect(calledInput.prompt).toContain(
      "Reference image URL: http://localhost/task-assets/image-to-code/dashboard-a.svg",
    );
    expect(calledInput.prompt).not.toContain(SHARED_PROMPT);
  });

  it("rejects oversized skillContent", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          skillContent: "x".repeat(MAX_SKILL_CONTENT_CHARS + 1),
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: `skillContent must be ${MAX_SKILL_CONTENT_CHARS} characters or fewer.`,
    });
  });

  it("rejects invalid task id", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          taskId: "bad_task",
          taskContext: {},
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "taskId is invalid.",
    });
  });

  it("validates required hf key", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelId: "moonshotai/kimi-k2-instruct",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provide hfApiKey or connect with Hugging Face OAuth.",
    });
  });

  it("uses oauth cookie token when hfApiKey is omitted", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>oauth route</body></html>",
      usedModel: "MiniMaxAI/MiniMax-M2.5",
      usedProvider: "auto",
      attempts: [
        {
          model: "MiniMaxAI/MiniMax-M2.5",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 700,
        },
      ],
    });

    const cookie = sealHfOAuthSession(
      buildHfOAuthSessionPayload({
        accessToken: "hf_oauth_cookie_token",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `hf_oauth_session=${cookie}`,
        },
        body: JSON.stringify({
          modelId: "MiniMaxAI/MiniMax-M2.5",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hfApiKey: "hf_oauth_cookie_token",
      }),
    );
  });

  it("uses body key over oauth cookie token when both exist", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>manual key wins</body></html>",
      usedModel: "MiniMaxAI/MiniMax-M2.5",
      usedProvider: "auto",
      attempts: [
        {
          model: "MiniMaxAI/MiniMax-M2.5",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 650,
        },
      ],
    });

    const cookie = sealHfOAuthSession(
      buildHfOAuthSessionPayload({
        accessToken: "hf_oauth_cookie_token",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `hf_oauth_session=${cookie}`,
        },
        body: JSON.stringify({
          hfApiKey: "hf_manual_key",
          modelId: "MiniMaxAI/MiniMax-M2.5",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hfApiKey: "hf_manual_key",
      }),
    );
  });

  it("returns 401 when oauth cookie token is expired", async () => {
    const expiredCookie = sealHfOAuthSession(
      buildHfOAuthSessionPayload({
        accessToken: "hf_oauth_cookie_token",
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `hf_oauth_session=${expiredCookie}`,
        },
        body: JSON.stringify({
          modelId: "MiniMaxAI/MiniMax-M2.5",
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Hugging Face OAuth session is invalid or expired. Reconnect with Hugging Face OAuth.",
    });
  });

  it("validates bill_to format", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          billTo: "billing team",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Bill To format is invalid.",
    });
  });

  it("accepts model-id:provider syntax without provider field", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>inline provider</body></html>",
      usedModel: "MiniMaxAI/MiniMax-M2.5:novita",
      usedProvider: "novita",
      attempts: [
        {
          model: "MiniMaxAI/MiniMax-M2.5:novita",
          provider: "novita",
          status: "success",
          retryable: false,
          durationMs: 800,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "MiniMaxAI/MiniMax-M2.5:novita",
        }),
      }),
    );

    expect(response.status).toBe(201);

    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "MiniMaxAI/MiniMax-M2.5",
        provider: "novita",
      }),
    );
  });

  it("accepts model-only generation and defaults to auto provider", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>auto route</body></html>",
      usedModel: "MiniMaxAI/MiniMax-M2.5",
      usedProvider: "auto",
      attempts: [
        {
          model: "MiniMaxAI/MiniMax-M2.5",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 600,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "MiniMaxAI/MiniMax-M2.5",
        }),
      }),
    );

    expect(response.status).toBe(201);

    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "MiniMaxAI/MiniMax-M2.5",
        provider: undefined,
      }),
    );
  });

  it("forwards provider candidates when provided", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateMock.mockResolvedValue({
      html: "<!doctype html><html><body>provider candidates</body></html>",
      usedModel: "MiniMaxAI/MiniMax-M2.5:novita",
      usedProvider: "novita",
      attempts: [
        {
          model: "MiniMaxAI/MiniMax-M2.5:novita",
          provider: "novita",
          status: "success",
          retryable: false,
          durationMs: 600,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "MiniMaxAI/MiniMax-M2.5",
          providers: ["novita", "auto", "NeBiUs"],
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "MiniMaxAI/MiniMax-M2.5",
        provider: undefined,
        providers: ["novita", "nebius"],
      }),
    );
  });

  it("returns error attempts when generation fails", async () => {
    const attempts: HfGenerationAttempt[] = [
      {
        model: "moonshotai/kimi-k2-instruct:novita",
        provider: "novita",
        status: "error",
        statusCode: 504,
        retryable: false,
        durationMs: 3500,
        detail: "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
      },
    ];

    generateMock.mockRejectedValue(
      new HFGenerationError(
        "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
        504,
        attempts,
      ),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          provider: "novita",
        }),
      }),
    );

    expect(response.status).toBe(504);

    const payload = (await response.json()) as {
      error: string;
      attempts: HfGenerationAttempt[];
    };

    expect(payload.error).toBe(
      "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
    );
    expect(payload.attempts).toEqual(attempts);
  });
});
