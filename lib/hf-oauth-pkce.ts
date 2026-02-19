import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

export const HF_OAUTH_NONCE_COOKIE_NAME = "hf_oauth_nonce";
export const HF_OAUTH_CODE_VERIFIER_COOKIE_NAME = "hf_oauth_code_verifier";

const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const PKCE_VERIFIER_LENGTH = 96;

function buildCookieBaseOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

function normalizeProviderOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return "https://huggingface.co";
  }
}

function buildCodeVerifier(length = PKCE_VERIFIER_LENGTH): string {
  const random = randomBytes(length);
  return Array.from(random)
    .map((value) => PKCE_ALPHABET[value % PKCE_ALPHABET.length])
    .join("");
}

function buildCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function buildHfOAuthAuthorizeUrl(input: {
  providerUrl: string;
  clientId: string;
  scopes: string[];
  redirectUrl: string;
  state: string;
  codeChallenge: string;
}): string {
  const authorizeUrl = new URL("/oauth/authorize", normalizeProviderOrigin(input.providerUrl));

  authorizeUrl.search = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes.join(" "),
    response_type: "code",
    redirect_uri: input.redirectUrl,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return authorizeUrl.toString();
}

export function createHfOAuthStartState() {
  const nonce = randomUUID();
  const codeVerifier = buildCodeVerifier();
  const codeChallenge = buildCodeChallenge(codeVerifier);

  return {
    nonce,
    codeVerifier,
    codeChallenge,
  };
}

export function setHfOAuthPkceCookies(
  response: NextResponse,
  input: { nonce: string; codeVerifier: string },
): void {
  const options = buildCookieBaseOptions();
  response.cookies.set({
    ...options,
    name: HF_OAUTH_NONCE_COOKIE_NAME,
    value: input.nonce,
  });
  response.cookies.set({
    ...options,
    name: HF_OAUTH_CODE_VERIFIER_COOKIE_NAME,
    value: input.codeVerifier,
  });
}

export function clearHfOAuthPkceCookies(response: NextResponse): void {
  const options = buildCookieBaseOptions();
  response.cookies.set({
    ...options,
    name: HF_OAUTH_NONCE_COOKIE_NAME,
    value: "",
    expires: new Date(0),
  });
  response.cookies.set({
    ...options,
    name: HF_OAUTH_CODE_VERIFIER_COOKIE_NAME,
    value: "",
    expires: new Date(0),
  });
}

export function readHfOAuthPkceCookies(
  request: NextRequest,
): { nonce?: string; codeVerifier?: string } {
  const nonce = request.cookies.get(HF_OAUTH_NONCE_COOKIE_NAME)?.value?.trim();
  const codeVerifier = request.cookies
    .get(HF_OAUTH_CODE_VERIFIER_COOKIE_NAME)
    ?.value?.trim();

  return {
    nonce: nonce || undefined,
    codeVerifier: codeVerifier || undefined,
  };
}
