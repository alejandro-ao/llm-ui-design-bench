import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const STATE_TOKEN_PREFIX = "v1";
const STATE_PAYLOAD_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_STATE_AGE_SECONDS = 15 * 60;

interface HfOAuthStatePayload {
  v: 1;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  issuedAt: number;
}

function normalizeSessionSecret(rawSecret: string): Buffer {
  const trimmed = rawSecret.trim();
  const decoded = Buffer.from(trimmed, "base64url");
  if (decoded.length === 32) {
    return decoded;
  }

  const fallbackDecoded = Buffer.from(trimmed, "base64");
  if (fallbackDecoded.length === 32) {
    return fallbackDecoded;
  }

  throw new Error("HF_SESSION_COOKIE_SECRET must decode to exactly 32 bytes.");
}

function resolveSessionSecret(): Buffer {
  const rawSecret = process.env.HF_SESSION_COOKIE_SECRET?.trim();
  if (!rawSecret) {
    throw new Error("HF_SESSION_COOKIE_SECRET is required for Hugging Face OAuth.");
  }

  return normalizeSessionSecret(rawSecret);
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function buildHfOAuthStateToken(input: {
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  issuedAt?: number;
}): string {
  const nonce = input.nonce.trim();
  const codeVerifier = input.codeVerifier.trim();
  const redirectUri = input.redirectUri.trim();

  if (!nonce || !codeVerifier || !redirectUri) {
    throw new Error("OAuth state token requires nonce, codeVerifier, and redirectUri.");
  }

  const payload: HfOAuthStatePayload = {
    v: STATE_PAYLOAD_VERSION,
    nonce,
    codeVerifier,
    redirectUri,
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
  };

  const secret = resolveSessionSecret();
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from("hf_oauth_state", "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [STATE_TOKEN_PREFIX, encodeBase64Url(iv), encodeBase64Url(tag), encodeBase64Url(encrypted)].join(
    ".",
  );
}

export function tryParseHfOAuthStateToken(token: string): HfOAuthStatePayload | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== STATE_TOKEN_PREFIX) {
    return null;
  }

  try {
    const secret = resolveSessionSecret();
    const iv = decodeBase64Url(parts[1]);
    const tag = decodeBase64Url(parts[2]);
    const encrypted = decodeBase64Url(parts[3]);

    if (iv.length !== AES_GCM_IV_BYTES || tag.length !== AES_GCM_TAG_BYTES || encrypted.length === 0) {
      throw new Error("OAuth state token is invalid.");
    }

    const decipher = createDecipheriv("aes-256-gcm", secret, iv);
    decipher.setAAD(Buffer.from("hf_oauth_state", "utf8"));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(decrypted.toString("utf8")) as Partial<HfOAuthStatePayload>;

    if (
      payload.v !== STATE_PAYLOAD_VERSION ||
      typeof payload.nonce !== "string" ||
      !payload.nonce.trim() ||
      typeof payload.codeVerifier !== "string" ||
      !payload.codeVerifier.trim() ||
      typeof payload.redirectUri !== "string" ||
      !payload.redirectUri.trim() ||
      typeof payload.issuedAt !== "number"
    ) {
      throw new Error("OAuth state token is invalid.");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.issuedAt <= 0 || nowSec - payload.issuedAt > MAX_STATE_AGE_SECONDS) {
      throw new Error("OAuth state token expired. Start OAuth again.");
    }

    return {
      v: STATE_PAYLOAD_VERSION,
      nonce: payload.nonce.trim(),
      codeVerifier: payload.codeVerifier.trim(),
      redirectUri: payload.redirectUri.trim(),
      issuedAt: Math.floor(payload.issuedAt),
    };
  } catch {
    return null;
  }
}
