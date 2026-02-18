// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/generate/hf/route";
import { getArtifactByModelId } from "@/lib/artifacts";

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
  it("generates and persists a public artifact", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    "```html\n<!doctype html><html><body>generated page</body></html>\n```",
                },
              },
            ],
          }),
          { status: 200 },
        ),
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
        }),
      }),
    );

    expect(response.status).toBe(201);

    const record = await getArtifactByModelId("moonshotai/kimi-k2-instruct", {
      projectRoot,
      preferLocal: true,
    });

    expect(record?.html).toContain("generated page");
    expect(record?.entry.label).toBe("kimi-k2-instruct");
    expect(record?.entry.provider).toBe("huggingface");
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
  });
});
