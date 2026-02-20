const STATE_PAYLOAD_VERSION = 1;
const DEFAULT_STATE_MAX_AGE_SECONDS = 15 * 60;

export interface HfOAuthStatePayload {
  v: 1;
  nonce: string;
  redirectUri: string;
  issuedAt: number;
  codeVerifier?: string;
}

interface BuildOAuthStateInput {
  nonce: string;
  redirectUri: string;
  issuedAt?: number;
  codeVerifier?: string;
}

function decodeBase64Url(input: string): string {
  try {
    return Buffer.from(input, "base64url").toString("utf8");
  } catch {
    throw new Error("OAuth state payload is invalid.");
  }
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }

  return value.trim();
}

export function buildHfOAuthStateToken(input: BuildOAuthStateInput): string {
  const nonce = assertString(input.nonce, "OAuth nonce is required.");
  const redirectUri = assertString(input.redirectUri, "OAuth redirect URI is required.");
  const codeVerifier =
    typeof input.codeVerifier === "string" && input.codeVerifier.trim()
      ? input.codeVerifier.trim()
      : undefined;

  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    throw new Error("OAuth state issuedAt is invalid.");
  }

  const payload: HfOAuthStatePayload = {
    v: STATE_PAYLOAD_VERSION,
    nonce,
    redirectUri,
    issuedAt: Math.floor(issuedAt),
    ...(codeVerifier ? { codeVerifier } : {}),
  };

  return encodeBase64Url(JSON.stringify(payload));
}

export function parseHfOAuthStateToken(token: string): HfOAuthStatePayload {
  const normalizedToken = assertString(token, "OAuth state payload is invalid.");
  const rawPayload = decodeBase64Url(normalizedToken);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new Error("OAuth state payload is invalid.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("OAuth state payload is invalid.");
  }

  const payload = parsed as Partial<HfOAuthStatePayload>;
  if (payload.v !== STATE_PAYLOAD_VERSION) {
    throw new Error("OAuth state payload is invalid.");
  }

  const nonce = assertString(payload.nonce, "OAuth state payload is invalid.");
  const redirectUri = assertString(payload.redirectUri, "OAuth state payload is invalid.");
  const issuedAt =
    typeof payload.issuedAt === "number" ? Math.floor(payload.issuedAt) : Number.NaN;

  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    throw new Error("OAuth state payload is invalid.");
  }

  const codeVerifier =
    typeof payload.codeVerifier === "string" && payload.codeVerifier.trim()
      ? payload.codeVerifier.trim()
      : undefined;

  return {
    v: STATE_PAYLOAD_VERSION,
    nonce,
    redirectUri,
    issuedAt,
    ...(codeVerifier ? { codeVerifier } : {}),
  };
}

export function validateHfOAuthStatePayload(
  payload: HfOAuthStatePayload,
  expectedRedirectUri: string,
  options?: {
    nowSeconds?: number;
    maxAgeSeconds?: number;
  },
): HfOAuthStatePayload {
  const normalizedExpectedRedirectUri = assertString(
    expectedRedirectUri,
    "OAuth redirect URL is invalid.",
  );
  if (payload.redirectUri !== normalizedExpectedRedirectUri) {
    throw new Error("OAuth redirect URL mismatch.");
  }

  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options?.maxAgeSeconds ?? DEFAULT_STATE_MAX_AGE_SECONDS;
  if (payload.issuedAt > nowSeconds || nowSeconds - payload.issuedAt > maxAgeSeconds) {
    throw new Error("OAuth state expired. Start OAuth again.");
  }

  return payload;
}
