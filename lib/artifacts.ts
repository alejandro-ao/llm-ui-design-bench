import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  getSupabaseAdminClient,
  getSupabaseBucketName,
  hasSupabaseConfig,
} from "@/lib/supabase-admin";

export type ArtifactSourceType = "model" | "agent" | "baseline";

export interface ArtifactManifestEntry {
  modelId: string;
  label: string;
  artifactPath: string;
  promptVersion: string;
  createdAt: string;
  sourceType: ArtifactSourceType;
  sourceRef?: string;
  provider?: string;
  vendor?: string;
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
  provider?: string;
  vendor?: string;
}

export interface ArtifactStoreOptions {
  projectRoot?: string;
  preferLocal?: boolean;
}

interface ArtifactDbRow {
  id: string;
  model_id: string;
  label: string;
  storage_path: string;
  prompt_version: string;
  source_type: ArtifactSourceType;
  source_ref: string | null;
  provider: string | null;
  vendor: string | null;
  created_at: string;
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
const MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;
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

function shouldUseSupabase(options?: ArtifactStoreOptions): boolean {
  if (options?.preferLocal) {
    return false;
  }

  return hasSupabaseConfig();
}

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

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
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
      "Invalid modelId. Use letters, numbers, slash, dot, underscore, or hyphen.",
      400,
    );
  }

  if (modelId.includes("..") || modelId.includes("//") || modelId.endsWith("/")) {
    throw new ArtifactError("Invalid modelId format.", 400);
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

function toStorageSlug(modelId: string): string {
  const cleaned = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

  const hash = createHash("sha1").update(modelId).digest("hex").slice(0, 8);
  return `${cleaned || "model"}-${hash}`;
}

function buildArtifactPath(modelId: string): string {
  const slug = toStorageSlug(modelId);
  return path.posix.join("data", "artifacts", slug, "index.html");
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

  const sourceRef = toOptionalString(entry.sourceRef);
  if (sourceRef) {
    normalizedEntry.sourceRef = sourceRef;
  }

  const provider = toOptionalString(entry.provider);
  if (provider) {
    normalizedEntry.provider = provider;
  }

  const vendor = toOptionalString(entry.vendor);
  if (vendor) {
    normalizedEntry.vendor = vendor;
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

function mapSupabaseRowToEntry(row: ArtifactDbRow): ArtifactManifestEntry {
  return {
    modelId: row.model_id,
    label: row.label,
    artifactPath: row.storage_path,
    promptVersion: row.prompt_version,
    sourceType: row.source_type,
    createdAt: assertIsoDate(row.created_at),
    sourceRef: row.source_ref ?? undefined,
    provider: row.provider ?? undefined,
    vendor: row.vendor ?? undefined,
  };
}

async function listSupabaseEntries(): Promise<ArtifactManifestEntry[]> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("artifacts")
    .select(
      "id,model_id,label,storage_path,prompt_version,source_type,source_ref,provider,vendor,created_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw new ArtifactError(`Unable to read artifacts from Supabase: ${error.message}`, 500);
  }

  const dedupedByModel = new Map<string, ArtifactDbRow>();
  for (const rawRow of data ?? []) {
    const row = rawRow as ArtifactDbRow;
    if (!dedupedByModel.has(row.model_id)) {
      dedupedByModel.set(row.model_id, row);
    }
  }

  return Array.from(dedupedByModel.values())
    .map((row) => mapSupabaseRowToEntry(row))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function getSupabaseArtifactByModelId(modelId: string): Promise<ArtifactRecord | null> {
  const client = getSupabaseAdminClient();

  const { data, error } = await client
    .from("artifacts")
    .select(
      "id,model_id,label,storage_path,prompt_version,source_type,source_ref,provider,vendor,created_at",
    )
    .eq("model_id", modelId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new ArtifactError(`Unable to read artifact metadata: ${error.message}`, 500);
  }

  const row = (data?.[0] ?? null) as ArtifactDbRow | null;
  if (!row) {
    return null;
  }

  const { data: htmlBlob, error: downloadError } = await client
    .storage
    .from(getSupabaseBucketName())
    .download(row.storage_path);

  if (downloadError || !htmlBlob) {
    return null;
  }

  const html = await htmlBlob.text();

  return {
    entry: mapSupabaseRowToEntry(row),
    html,
  };
}

async function upsertSupabaseArtifact(input: UpsertArtifactInput): Promise<ArtifactManifestEntry> {
  const client = getSupabaseAdminClient();
  const createdAt = new Date().toISOString();
  const storagePath = `artifacts/${toStorageSlug(input.modelId)}/${Date.now()}-${randomUUID()}.html`;
  const bucketName = getSupabaseBucketName();

  const { error: uploadError } = await client
    .storage
    .from(bucketName)
    .upload(storagePath, new Blob([input.html], { type: "text/html; charset=utf-8" }), {
      contentType: "text/html; charset=utf-8",
      upsert: false,
    });

  if (uploadError) {
    throw new ArtifactError(`Unable to upload artifact HTML: ${uploadError.message}`, 500);
  }

  const payload = {
    model_id: input.modelId,
    label: input.label,
    storage_path: storagePath,
    prompt_version: input.promptVersion,
    source_type: input.sourceType,
    source_ref: input.sourceRef ?? null,
    provider: input.provider ?? null,
    vendor: input.vendor ?? null,
    created_at: createdAt,
  };

  const { data: existingRows, error: existingError } = await client
    .from("artifacts")
    .select("id,storage_path")
    .eq("model_id", input.modelId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (existingError) {
    await client.storage.from(bucketName).remove([storagePath]);
    throw new ArtifactError(`Unable to read existing artifact metadata: ${existingError.message}`, 500);
  }

  const existingRow = (existingRows?.[0] ?? null) as { id: string; storage_path: string } | null;

  const mutation = existingRow
    ? client
        .from("artifacts")
        .update(payload)
        .eq("id", existingRow.id)
        .select(
          "id,model_id,label,storage_path,prompt_version,source_type,source_ref,provider,vendor,created_at",
        )
        .single()
    : client
        .from("artifacts")
        .insert(payload)
        .select(
          "id,model_id,label,storage_path,prompt_version,source_type,source_ref,provider,vendor,created_at",
        )
        .single();

  const { data: savedRow, error: saveError } = await mutation;

  if (saveError || !savedRow) {
    await client.storage.from(bucketName).remove([storagePath]);
    throw new ArtifactError(`Unable to persist artifact metadata: ${saveError?.message ?? "unknown error"}`, 500);
  }

  if (existingRow?.storage_path && existingRow.storage_path !== storagePath) {
    await client.storage.from(bucketName).remove([existingRow.storage_path]);
  }

  return mapSupabaseRowToEntry(savedRow as ArtifactDbRow);
}

async function listLocalEntries(options?: ArtifactStoreOptions): Promise<ArtifactManifestEntry[]> {
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

async function getLocalArtifactByModelId(
  modelId: string,
  options?: ArtifactStoreOptions,
): Promise<ArtifactRecord | null> {
  const entries = await listLocalEntries(options);
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

async function upsertLocalArtifact(
  input: UpsertArtifactInput,
  options?: ArtifactStoreOptions,
): Promise<ArtifactManifestEntry> {
  const entries = await listLocalEntries(options);
  const createdAt = new Date().toISOString();
  const artifactPath = buildArtifactPath(input.modelId);

  const nextEntry: ArtifactManifestEntry = {
    modelId: input.modelId,
    label: input.label,
    artifactPath,
    promptVersion: input.promptVersion,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    provider: input.provider,
    vendor: input.vendor,
    createdAt,
  };

  const currentIndex = entries.findIndex((entry) => entry.modelId === input.modelId);
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
  await fs.writeFile(outputFilePath, input.html, "utf8");

  const normalizedEntries = entries.sort((a, b) => a.label.localeCompare(b.label));
  await fs.writeFile(manifestPath, JSON.stringify(normalizedEntries, null, 2), "utf8");

  return nextEntry;
}

export async function listManifestEntries(
  options?: ArtifactStoreOptions,
): Promise<ArtifactManifestEntry[]> {
  if (shouldUseSupabase(options)) {
    return listSupabaseEntries();
  }

  return listLocalEntries(options);
}

export async function getArtifactByModelId(
  modelId: string,
  options?: ArtifactStoreOptions,
): Promise<ArtifactRecord | null> {
  const normalizedModelId = assertValidModelId(assertString(modelId, "modelId"));

  if (shouldUseSupabase(options)) {
    return getSupabaseArtifactByModelId(normalizedModelId);
  }

  return getLocalArtifactByModelId(normalizedModelId, options);
}

export async function upsertArtifact(
  input: UpsertArtifactInput,
  options?: ArtifactStoreOptions,
): Promise<ArtifactManifestEntry> {
  const modelId = assertValidModelId(assertString(input.modelId, "modelId"));
  const label = assertString(input.label, "label");
  const promptVersion = assertString(input.promptVersion, "promptVersion");
  const sourceType = assertSourceType(input.sourceType);
  const sourceRef = toOptionalString(input.sourceRef);
  const provider = toOptionalString(input.provider);
  const vendor = toOptionalString(input.vendor);
  const html = input.html;

  if (typeof html !== "string" || html.trim().length === 0) {
    throw new ArtifactError("Invalid html payload.", 400);
  }

  validateHtmlArtifact(html);

  const normalizedInput: UpsertArtifactInput = {
    modelId,
    label,
    html,
    promptVersion,
    sourceType,
    sourceRef,
    provider,
    vendor,
  };

  if (shouldUseSupabase(options)) {
    return upsertSupabaseArtifact(normalizedInput);
  }

  return upsertLocalArtifact(normalizedInput, options);
}
