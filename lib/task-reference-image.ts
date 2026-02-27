import { promises as fs } from "node:fs";
import path from "node:path";

import type { GenerationReferenceImage } from "@/lib/generation-types";
import {
  getImageToCodeReference,
  type TaskContext,
  type TaskContextById,
  type TaskId,
} from "@/lib/tasks";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function normalizePublicAssetPath(assetPath: string): string | null {
  const stripped = assetPath.startsWith("/") ? assetPath.slice(1) : assetPath;
  const normalized = path.posix.normalize(stripped);

  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return null;
  }

  return normalized;
}

function resolveImageMimeType(assetPath: string): string | null {
  const extension = path.extname(assetPath).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

async function readAssetFromPublic(relativeAssetPath: string): Promise<Buffer> {
  const candidateRoots = [
    path.resolve(process.env.PROJECT_ROOT ?? process.cwd()),
    path.resolve(process.cwd()),
  ];
  const uniqueRoots = [...new Set(candidateRoots)];
  const segments = relativeAssetPath.split("/").filter(Boolean);

  for (const root of uniqueRoots) {
    const absoluteAssetPath = path.join(root, "public", ...segments);
    try {
      return await fs.readFile(absoluteAssetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Reference image asset was not found: ${relativeAssetPath}`);
}

export async function buildTaskReferenceImage(
  taskId: TaskId,
  taskContext: TaskContext,
): Promise<GenerationReferenceImage | null> {
  if (taskId !== "image_to_code") {
    return null;
  }

  const imageContext = taskContext as TaskContextById["image_to_code"];
  const reference = getImageToCodeReference(imageContext.imageId);
  const relativeAssetPath = normalizePublicAssetPath(reference.assetPath);
  if (!relativeAssetPath) {
    return null;
  }

  const mimeType = resolveImageMimeType(reference.assetPath);
  if (!mimeType) {
    return null;
  }

  const bytes = await readAssetFromPublic(relativeAssetPath);
  return {
    mimeType,
    base64Data: bytes.toString("base64"),
  };
}
