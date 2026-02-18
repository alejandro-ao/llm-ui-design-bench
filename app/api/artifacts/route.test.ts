// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/artifacts/route";
import { getArtifactByModelId } from "@/lib/artifacts";

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-route-tests-"));
  await fs.mkdir(path.join(projectRoot, "data", "artifacts"), { recursive: true });
  return projectRoot;
}

describe("artifact route", () => {
  it("returns artifact list and detail payloads", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const manifest = [
      {
        modelId: "baseline",
        label: "Baseline",
        artifactPath: "data/artifacts/baseline/index.html",
        promptVersion: "v1",
        createdAt: "2026-02-18T00:00:00.000Z",
        sourceType: "baseline",
      },
    ];

    await fs.mkdir(path.join(projectRoot, "data", "artifacts", "baseline"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectRoot, "data", "artifacts", "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "data", "artifacts", "baseline", "index.html"),
      "<html><body>baseline route</body></html>",
      "utf8",
    );

    const listResponse = await GET(new NextRequest("http://localhost/api/artifacts"));
    expect(listResponse.status).toBe(200);

    const listBody = (await listResponse.json()) as {
      entries: Array<{ modelId: string }>;
    };

    expect(listBody.entries).toHaveLength(1);
    expect(listBody.entries[0]?.modelId).toBe("baseline");

    const detailResponse = await GET(
      new NextRequest("http://localhost/api/artifacts?modelId=baseline"),
    );

    expect(detailResponse.status).toBe(200);

    const detailBody = (await detailResponse.json()) as { html: string };
    expect(detailBody.html).toContain("baseline route");
  });

  it("ingests a new artifact through POST", async () => {
    const projectRoot = await createProjectRoot();
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const request = new NextRequest("http://localhost/api/artifacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelId: "test-agent",
        label: "Test Agent",
        promptVersion: "v1",
        sourceType: "agent",
        html: "<html><body>agent output</body></html>",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const record = await getArtifactByModelId("test-agent", { projectRoot, preferLocal: true });
    expect(record?.html).toContain("agent output");
  });
});
