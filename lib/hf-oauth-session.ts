import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { NextResponse } from "next/server";
import { buildHfOAuthCookieBaseOptions } from "@/lib/hf-oauth-cookie-options";

export const HF_OAUTH_SESSION_COOKIE_NAME = "hf_oauth_session";

const SESSION_TOKEN_PREFIX = "v1";
const SESSION_PAYLOAD_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

type SessionErrorReason = "invalid" | "expired" | "misconfigured";

interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface HfOAuthSessionPayload {
  v: 1;
  accessToken: string;
  expiresAt: number | null;
  issuedAt: number;
}

interface HfOAuthSessionCookieInput {
  accessToken: string;
  expiresAt: number | null;
  issuedAt?: number;
}

export class HfOAuthSessionError extends Error {
  status: number;
  reason: SessionErrorReason;

  constructor(message: string, status: number, reason: SessionErrorReason) {
    super(message);
    this.name = "HfOAuthSessionError";
    this.status = status;
    this.reason = reason;
  }
}

function createSessionError(
  message = "Hugging Face OAuth session is invalid. Reconnect with Hugging Face OAuth.",
  reason: SessionErrorReason = "invalid",
  status = 401,
): HfOAuthSessionError {
  return new HfOAuthSessionError(message, status, reason);
}

function normalizeSessionSecret(rawSecret: string): Buffer {
  const trimmed = rawSecret.trim();
  if (!trimmed) {
    throw createSessionError(
      "HF_SESSION_COOKIE_SECRET is required for Hugging Face OAuth session storage.",
      "misconfigured",
      500,
    );
  }

  const decoded = Buffer.from(trimmed, "base64url");
  if (decoded.length === 32) {
    return decoded;
  }

  const fallbackDecoded = Buffer.from(trimmed, "base64");
  if (fallbackDecoded.length === 32) {
    return fallbackDecoded;
  }

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Accept arbitrary non-empty secrets by deriving a fixed-size key.
  return createHash("sha256").update(trimmed, "utf8").digest();
}

function resolveSessionSecret(): Buffer {
  const rawSecret =
    process.env.HF_SESSION_COOKIE_SECRET?.trim() ||
    process.env.OAUTH_CLIENT_SECRET?.trim() ||
    process.env.HF_OAUTH_CLIENT_SECRET?.trim();
  if (!rawSecret) {
    throw createSessionError(
      "HF_SESSION_COOKIE_SECRET (or OAuth client secret) is required for Hugging Face OAuth session storage.",
      "misconfigured",
      500,
    );
  }

  return normalizeSessionSecret(rawSecret);
}

function assertValidPayload(payload: unknown): asserts payload is HfOAuthSessionPayload {
  const candidate = payload as Partial<HfOAuthSessionPayload>;
  if (candidate?.v !== SESSION_PAYLOAD_VERSION) {
    throw createSessionError();
  }

  if (!candidate.accessToken || typeof candidate.accessToken !== "string") {
    throw createSessionError();
  }

  if (candidate.expiresAt !== null && typeof candidate.expiresAt !== "number") {
    throw createSessionError();
  }

  if (
    typeof candidate.issuedAt !== "number" ||
    !Number.isFinite(candidate.issuedAt) ||
    candidate.issuedAt <= 0
  ) {
    throw createSessionError();
  }
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw createSessionError();
  }
}

export function buildHfOAuthSessionPayload(
  input: HfOAuthSessionCookieInput,
): HfOAuthSessionPayload {
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    throw createSessionError("OAuth access token is required.", "invalid", 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt =
    input.expiresAt === null || input.expiresAt === undefined ? null : Math.floor(input.expiresAt);

  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= 0)) {
    throw createSessionError("OAuth token expiration must be a valid unix timestamp.", "invalid", 400);
  }

  return {
    v: SESSION_PAYLOAD_VERSION,
    accessToken,
    expiresAt,
    issuedAt: input.issuedAt ?? nowSec,
  };
}

export function sealHfOAuthSession(payload: HfOAuthSessionPayload): string {
  const secret = resolveSessionSecret();
  const iv = randomBytes(AES_GCM_IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(HF_OAUTH_SESSION_COOKIE_NAME, "utf8"));

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    SESSION_TOKEN_PREFIX,
    encodeBase64Url(iv),
    encodeBase64Url(authTag),
    encodeBase64Url(encrypted),
  ].join(".");
}

export function unsealHfOAuthSession(token: string): HfOAuthSessionPayload {
  const secret = resolveSessionSecret();
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_TOKEN_PREFIX) {
    throw createSessionError();
  }

  const iv = decodeBase64Url(parts[1]);
  const authTag = decodeBase64Url(parts[2]);
  const encrypted = decodeBase64Url(parts[3]);

  if (iv.length !== AES_GCM_IV_BYTES || authTag.length !== AES_GCM_TAG_BYTES || encrypted.length === 0) {
    throw createSessionError();
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", secret, iv);
    decipher.setAAD(Buffer.from(HF_OAUTH_SESSION_COOKIE_NAME, "utf8"));
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString("utf8")) as unknown;
    assertValidPayload(parsed);

    return parsed;
  } catch {
    throw createSessionError();
  }
}

export function getHfOAuthSessionFromCookies(cookies: CookieReader): HfOAuthSessionPayload | null {
  const cookieValue = cookies.get(HF_OAUTH_SESSION_COOKIE_NAME)?.value;
  if (!cookieValue) {
    return null;
  }

  const payload = unsealHfOAuthSession(cookieValue);
  if (payload.expiresAt !== null && payload.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw createSessionError(
      "Hugging Face OAuth session expired. Reconnect with Hugging Face OAuth.",
      "expired",
      401,
    );
  }

  return payload;
}

export function setHfOAuthSessionCookie(
  response: NextResponse,
  payload: HfOAuthSessionPayload,
): void {
  const cookieBaseOptions = buildHfOAuthCookieBaseOptions();
  response.cookies.set({
    ...cookieBaseOptions,
    name: HF_OAUTH_SESSION_COOKIE_NAME,
    value: sealHfOAuthSession(payload),
  });
}

export function clearHfOAuthSessionCookie(response: NextResponse): void {
  const cookieBaseOptions = buildHfOAuthCookieBaseOptions();
  response.cookies.set({
    ...cookieBaseOptions,
    name: HF_OAUTH_SESSION_COOKIE_NAME,
    value: "",
    expires: new Date(0),
  });
}
