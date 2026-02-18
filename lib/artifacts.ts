import { promises as fs } from "node:fs";
import path from "node:path";

export type ArtifactSourceType = "model" | "agent" | "baseline";

export interface ArtifactManifestEntry {
  modelId: string;
  label: string;
  artifactPath: string;
  promptVersion: string;
  createdAt: string;
  sourceType: ArtifactSourceType;
  sourceRef?: string;
}

export interface ArtifactRecord {
  entry: ArtifactManifestEntry;
  html: string;
}

export interface UpsertArtifactInput {
  modelId: string;
  label: string;
  html: string;
  promptVersion: string;
  sourceType: ArtifactSourceType;
  sourceRef?: string;
}

export interface ArtifactStoreOptions {
  projectRoot?: string;
}

export class ArtifactError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ArtifactError";
    this.status = status;
  }
}

const MAX_HTML_BYTES = 500 * 1024;
const MODEL_ID_REGEX = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const SOURCE_TYPES: ArtifactSourceType[] = ["model", "agent", "baseline"];

const DANGEROUS_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /(?:href|src|action)\s*=\s*["']\s*javascript\s*:/i,
    reason: "javascript: URLs are not allowed in artifact HTML.",
  },
  {
    regex: /<meta[^>]+http-equiv\s*=\s*["']?\s*refresh/i,
    reason: "Meta refresh tags are not allowed in artifact HTML.",
  },
  {
    regex: /<iframe[^>]+src\s*=\s*["']\s*javascript\s*:/i,
    reason: "Iframe javascript: sources are not allowed in artifact HTML.",
  },
];

function getProjectRoot(options?: ArtifactStoreOptions): string {
  return path.resolve(options?.projectRoot ?? process.env.PROJECT_ROOT ?? process.cwd());
}

function getArtifactsRoot(options?: ArtifactStoreOptions): string {
  return path.join(getProjectRoot(options), "data", "artifacts");
}

function getManifestPath(options?: ArtifactStoreOptions): string {
  return path.join(getArtifactsRoot(options), "manifest.json");
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArtifactError(`Invalid ${fieldName}.`, 400);
  }

  return value.trim();
}

function assertSourceType(value: unknown): ArtifactSourceType {
  if (typeof value !== "string" || !SOURCE_TYPES.includes(value as ArtifactSourceType)) {
    throw new ArtifactError("Invalid sourceType.", 400);
  }

  return value as ArtifactSourceType;
}

function assertValidModelId(modelId: string): string {
  if (!MODEL_ID_REGEX.test(modelId)) {
    throw new ArtifactError(
      "Invalid modelId. Use lowercase letters, numbers, hyphen, or underscore.",
      400,
    );
  }

  return modelId;
}

function assertIsoDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ArtifactError("Invalid createdAt value in manifest.", 500);
  }

  return date.toISOString();
}

function buildArtifactPath(modelId: string): string {
  return path.posix.join("data", "artifacts", modelId, "index.html");
}

function isInsideDirectory(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);

  if (resolvedBase === resolvedCandidate) {
    return true;
  }

  return resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function resolveArtifactAbsolutePath(
  artifactPath: string,
  options?: ArtifactStoreOptions,
): string {
  const projectRoot = getProjectRoot(options);
  const artifactsRoot = getArtifactsRoot(options);
  const absolutePath = path.resolve(projectRoot, artifactPath);

  if (!isInsideDirectory(artifactsRoot, absolutePath)) {
    throw new ArtifactError("artifactPath must resolve inside data/artifacts.", 500);
  }

  return absolutePath;
}

function validateManifestEntry(rawEntry: unknown): ArtifactManifestEntry {
  if (typeof rawEntry !== "object" || rawEntry === null) {
    throw new ArtifactError("Manifest contains an invalid entry.", 500);
  }

  const entry = rawEntry as Record<string, unknown>;
  const modelId = assertValidModelId(assertString(entry.modelId, "modelId"));
  const label = assertString(entry.label, "label");
  const artifactPath = assertString(entry.artifactPath, "artifactPath");
  const promptVersion = assertString(entry.promptVersion, "promptVersion");
  const sourceType = assertSourceType(entry.sourceType);
  const createdAt = assertIsoDate(assertString(entry.createdAt, "createdAt"));

  const normalizedEntry: ArtifactManifestEntry = {
    modelId,
    label,
    artifactPath,
    promptVersion,
    sourceType,
    createdAt,
  };

  if (entry.sourceRef !== undefined) {
    normalizedEntry.sourceRef = assertString(entry.sourceRef, "sourceRef");
  }

  return normalizedEntry;
}

function validateHtmlArtifact(html: string): void {
  const payloadBytes = Buffer.byteLength(html, "utf8");
  if (payloadBytes > MAX_HTML_BYTES) {
    throw new ArtifactError(`HTML payload exceeds ${MAX_HTML_BYTES} bytes.`, 400);
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.regex.test(html)) {
      throw new ArtifactError(pattern.reason, 400);
    }
  }
}

export async function listManifestEntries(
  options?: ArtifactStoreOptions,
): Promise<ArtifactManifestEntry[]> {
  const manifestPath = getManifestPath(options);

  try {
    await fs.access(manifestPath);
  } catch {
    return [];
  }

  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(manifestRaw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new ArtifactError("Manifest must be a JSON array.", 500);
  }

  return parsed
    .map((entry) => validateManifestEntry(entry))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getArtifactByModelId(
  modelId: string,
  options?: ArtifactStoreOptions,
): Promise<ArtifactRecord | null> {
  const entries = await listManifestEntries(options);
  const target = entries.find((entry) => entry.modelId === modelId);

  if (!target) {
    return null;
  }

  const artifactPath = resolveArtifactAbsolutePath(target.artifactPath, options);

  try {
    const html = await fs.readFile(artifactPath, "utf8");
    return { entry: target, html };
  } catch {
    return null;
  }
}

export async function upsertArtifact(
  input: UpsertArtifactInput,
  options?: ArtifactStoreOptions,
): Promise<ArtifactManifestEntry> {
  const modelId = assertValidModelId(assertString(input.modelId, "modelId"));
  const label = assertString(input.label, "label");
  const promptVersion = assertString(input.promptVersion, "promptVersion");
  const sourceType = assertSourceType(input.sourceType);
  const sourceRef = input.sourceRef ? assertString(input.sourceRef, "sourceRef") : undefined;
  const html = input.html;

  if (typeof html !== "string" || html.trim().length === 0) {
    throw new ArtifactError("Invalid html payload.", 400);
  }

  validateHtmlArtifact(html);

  const entries = await listManifestEntries(options);
  const createdAt = new Date().toISOString();
  const artifactPath = buildArtifactPath(modelId);

  const nextEntry: ArtifactManifestEntry = {
    modelId,
    label,
    artifactPath,
    promptVersion,
    sourceType,
    sourceRef,
    createdAt,
  };

  const currentIndex = entries.findIndex((entry) => entry.modelId === modelId);
  if (currentIndex >= 0) {
    entries[currentIndex] = nextEntry;
  } else {
    entries.push(nextEntry);
  }

  const artifactsRoot = getArtifactsRoot(options);
  const manifestPath = getManifestPath(options);
  const outputFilePath = resolveArtifactAbsolutePath(artifactPath, options);

  await fs.mkdir(artifactsRoot, { recursive: true });
  await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
  await fs.writeFile(outputFilePath, html, "utf8");

  const normalizedEntries = entries.sort((a, b) => a.label.localeCompare(b.label));
  await fs.writeFile(manifestPath, JSON.stringify(normalizedEntries, null, 2), "utf8");

  return nextEntry;
}
