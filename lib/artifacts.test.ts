// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getArtifactByModelId, listManifestEntries, upsertArtifact } from "@/lib/artifacts";

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-tests-"));
  await fs.mkdir(path.join(projectRoot, "data", "artifacts"), { recursive: true });
  return projectRoot;
}

describe("artifact manifest store", () => {
  it("loads manifest entries and reads artifact html", async () => {
    const projectRoot = await createProjectRoot();

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
      "<html><body>baseline</body></html>",
      "utf8",
    );

    const entries = await listManifestEntries({ projectRoot, preferLocal: true });
    const record = await getArtifactByModelId("baseline", { projectRoot, preferLocal: true });

    expect(entries).toHaveLength(1);
    expect(record?.entry.modelId).toBe("baseline");
    expect(record?.html).toContain("baseline");
  });

  it("writes artifact html and updates manifest", async () => {
    const projectRoot = await createProjectRoot();

    const entry = await upsertArtifact(
      {
        modelId: "kimi-k2-instruct",
        label: "Kimi",
        html: "<html><body>hello</body></html>",
        promptVersion: "v1",
        sourceType: "model",
      },
      { projectRoot, preferLocal: true },
    );

    expect(entry.modelId).toBe("kimi-k2-instruct");

    const manifestRaw = await fs.readFile(
      path.join(projectRoot, "data", "artifacts", "manifest.json"),
      "utf8",
    );

    const manifest = JSON.parse(manifestRaw) as Array<{ modelId: string }>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.modelId).toBe("kimi-k2-instruct");
  });

  it("rejects html containing javascript url payloads", async () => {
    const projectRoot = await createProjectRoot();

    await expect(
      upsertArtifact(
        {
          modelId: "bad-model",
          label: "Bad Model",
          html: "<html><body><a href='javascript:alert(1)'>boom</a></body></html>",
          promptVersion: "v1",
          sourceType: "model",
        },
        { projectRoot, preferLocal: true },
      ),
    ).rejects.toThrow("javascript: URLs are not allowed");
  });
});
