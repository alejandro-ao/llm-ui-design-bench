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
import { getArtifactByModelId } from "@/lib/artifacts";
import { HFGenerationError, type HfGenerationAttempt } from "@/lib/hf-generation";

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

describe("POST /api/generate/hf/stream", () => {
  beforeEach(() => {
    generateStreamMock.mockReset();
  });

  it("streams meta->attempt->token->complete->done and persists artifact", async () => {
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

    const record = await getArtifactByModelId("moonshotai/kimi-k2-instruct", {
      projectRoot,
      preferLocal: true,
    });

    expect(record?.html).toContain("stream token");
    expect(record?.entry.sourceRef).toBe("huggingface:moonshotai/kimi-k2-instruct:novita");
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
});
