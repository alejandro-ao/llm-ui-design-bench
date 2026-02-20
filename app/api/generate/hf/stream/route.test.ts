// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { generateStreamMock } = vi.hoisted(() => ({
  generateStreamMock: vi.fn(),
}));

vi.mock("@/lib/hf-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hf-generation")>();
  return {
    ...actual,
    generateHtmlWithHuggingFaceStreamed: generateStreamMock,
  };
});

import { POST } from "@/app/api/generate/hf/stream/route";
import { HFGenerationError, type HfGenerationAttempt } from "@/lib/hf-generation";
import {
  buildHfOAuthSessionPayload,
  sealHfOAuthSession,
} from "@/lib/hf-oauth-session";
import { MAX_SKILL_CONTENT_CHARS, SHARED_PROMPT } from "@/lib/prompt";

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generate-hf-stream-tests-"));
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

function extractSseEvents(raw: string): string[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.split("\n").find((line) => line.startsWith("event:")) ?? "")
    .map((line) => line.replace("event:", "").trim())
    .filter(Boolean);
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

describe("POST /api/generate/hf/stream", () => {
  beforeEach(() => {
    generateStreamMock.mockReset();
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 13).toString("base64url");
  });

  it("streams meta->attempt->token->complete->done without persisting artifact", async () => {
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
        durationMs: 900,
      },
    ];

    generateStreamMock.mockImplementation(
      async (input: {
        onAttempt?: (value: unknown) => Promise<void> | void;
        onToken?: (value: string) => Promise<void> | void;
      }) => {
        await input.onAttempt?.({
          attemptNumber: 1,
          totalAttempts: 1,
          model: "moonshotai/kimi-k2-instruct:novita",
          provider: "novita",
          resetCode: false,
        });
        await input.onToken?.("<!doctype html><html><body>stream token</body></html>");

        return {
          html: "<!doctype html><html><body>stream token</body></html>",
          usedModel: "moonshotai/kimi-k2-instruct:novita",
          usedProvider: "novita",
          attempts,
        };
      },
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const rawStream = await response.text();
    const events = extractSseEvents(rawStream);

    expect(events).toContain("meta");
    expect(events).toContain("attempt");
    expect(events).toContain("token");
    expect(events).toContain("complete");
    expect(events.at(-1)).toBe("done");
    const completePayload = extractSseEventPayload<{
      result: {
        modelId: string;
        html: string;
        provider: string;
      };
      generation: {
        usedProvider: string;
      };
    }>(rawStream, "complete");
    expect(completePayload).toMatchObject({
      result: {
        modelId: "moonshotai/kimi-k2-instruct",
        html: "<!doctype html><html><body>stream token</body></html>",
        provider: "huggingface",
      },
      generation: {
        usedProvider: "novita",
      },
    });
    expect(rawStream).not.toContain("Saving artifact");
  });

  it("accepts skillContent and composes prompt context", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateStreamMock.mockResolvedValue({
      html: "<!doctype html><html><body>skill output</body></html>",
      usedModel: "moonshotai/kimi-k2-instruct",
      usedProvider: "auto",
      attempts: [
        {
          model: "moonshotai/kimi-k2-instruct",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 850,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          skillContent: "  Favor asymmetric hero layouts and clear visual rhythm.  ",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(generateStreamMock).toHaveBeenCalled();
    const calledInput = generateStreamMock.mock.calls.at(-1)?.[0] as { prompt: string };
    expect(calledInput.prompt).toContain(SHARED_PROMPT);
    expect(calledInput.prompt).toContain("Additional user-provided design skill");
    expect(calledInput.prompt).toContain("--- BEGIN USER SKILL ---");
    expect(calledInput.prompt).toContain("Favor asymmetric hero layouts and clear visual rhythm.");
    expect(calledInput.prompt).toContain("--- END USER SKILL ---");
  });

  it("accepts clone_website task context and includes taskId in stream meta", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateStreamMock.mockResolvedValue({
      html: "<!doctype html><html><body>clone output</body></html>",
      usedModel: "moonshotai/kimi-k2-instruct",
      usedProvider: "auto",
      attempts: [
        {
          model: "moonshotai/kimi-k2-instruct",
          provider: "auto",
          status: "success",
          retryable: false,
          durationMs: 910,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hfApiKey: "hf_test_key",
          modelId: "moonshotai/kimi-k2-instruct",
          taskId: "clone_website",
          taskContext: {
            targetId: "airbnb_home",
            screenshotUrl: "http://localhost/task-assets/clone/airbnb-home.svg",
            referenceNotes: "Match layout and spacing rhythm.",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const rawStream = await response.text();
    const metaPayload = extractSseEventPayload<{
      taskId?: string;
      modelId: string;
      plannedAttempts: number;
    }>(rawStream, "meta");

    expect(metaPayload).toMatchObject({
      taskId: "clone_website",
      modelId: "moonshotai/kimi-k2-instruct",
      plannedAttempts: 1,
    });

    const calledInput = generateStreamMock.mock.calls.at(-1)?.[0] as {
      prompt: string;
      baselineHtml: string;
    };
    expect(calledInput.baselineHtml).toBe("");
    expect(calledInput.prompt).toContain("Target website: Airbnb Home");
    expect(calledInput.prompt).toContain(
      "Reference screenshot URL: http://localhost/task-assets/clone/airbnb-home.svg",
    );
  });

  it("rejects oversized skillContent", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

  it("rejects invalid task context", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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
            imageUrl: "/task-assets/image-to-code/dashboard-a.svg",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "taskContext.imageUrl must be an absolute http(s) URL.",
    });
  });

  it("emits error with attempts and done on terminal failure", async () => {
    const attempts: HfGenerationAttempt[] = [
      {
        model: "moonshotai/kimi-k2-instruct:novita",
        provider: "novita",
        status: "error",
        retryable: false,
        statusCode: 504,
        durationMs: 1200,
        detail: "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
      },
    ];

    generateStreamMock.mockRejectedValue(
      new HFGenerationError(
        "Hugging Face provider timed out. Try another provider, retry, or use a faster model.",
        504,
        attempts,
      ),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

    expect(response.status).toBe(200);

    const rawStream = await response.text();
    const events = extractSseEvents(rawStream);

    expect(events).toContain("error");
    expect(events.at(-1)).toBe("done");
    expect(rawStream).toContain("Hugging Face provider timed out");
  });

  it("accepts model-only payload and forwards undefined provider", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateStreamMock.mockResolvedValue({
      html: "<!doctype html><html><body>auto route</body></html>",
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

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

    expect(response.status).toBe(200);
    expect(generateStreamMock).toHaveBeenCalledWith(
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

    generateStreamMock.mockResolvedValue({
      html: "<!doctype html><html><body>provider candidates</body></html>",
      usedModel: "MiniMaxAI/MiniMax-M2.5:novita",
      usedProvider: "novita",
      attempts: [
        {
          model: "MiniMaxAI/MiniMax-M2.5:novita",
          provider: "novita",
          status: "success",
          retryable: false,
          durationMs: 700,
        },
      ],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

    expect(response.status).toBe(200);
    expect(generateStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "MiniMaxAI/MiniMax-M2.5",
        provider: undefined,
        providers: ["novita", "nebius"],
      }),
    );
  });

  it("uses oauth cookie token when hfApiKey is omitted", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    generateStreamMock.mockResolvedValue({
      html: "<!doctype html><html><body>oauth route</body></html>",
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
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

    expect(response.status).toBe(200);
    expect(generateStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hfApiKey: "hf_oauth_cookie_token",
      }),
    );
  });

  it("returns 400 when neither hfApiKey nor oauth session are provided", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          modelId: "MiniMaxAI/MiniMax-M2.5",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provide hfApiKey or connect with Hugging Face OAuth.",
    });
  });

  it("returns 401 for expired oauth cookie token", async () => {
    const cookie = sealHfOAuthSession(
      buildHfOAuthSessionPayload({
        accessToken: "hf_oauth_cookie_token",
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/generate/hf/stream", {
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

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Hugging Face OAuth session is invalid or expired. Reconnect with Hugging Face OAuth.",
    });
  });
});
