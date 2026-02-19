import { NextRequest, NextResponse } from "next/server";

import { resolveHfOAuthConfig, resolveHfOAuthRedirectUrl } from "@/lib/hf-oauth-config";
import { clearHfOAuthPkceCookies, readHfOAuthPkceCookies } from "@/lib/hf-oauth-pkce";
import { tryParseHfOAuthStateToken } from "@/lib/hf-oauth-state";
import {
  buildHfOAuthSessionPayload,
  HfOAuthSessionError,
  setHfOAuthSessionCookie,
} from "@/lib/hf-oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExchangePayload {
  code?: string;
  codeVerifier?: string;
  nonce?: string;
  state?: string;
  redirectUri?: string;
}

interface ParsedOAuthState {
  nonce: string;
  redirectUri?: string;
  codeVerifier?: string;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeProviderOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return "https://huggingface.co";
  }
}

function parseOAuthState(rawState: string, expectedNonce: string): ParsedOAuthState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawState);
  } catch {
    throw new Error("OAuth state payload is invalid.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("OAuth state payload is invalid.");
  }

  const state = parsed as { nonce?: unknown; redirectUri?: unknown };
  const nonce = typeof state.nonce === "string" ? state.nonce.trim() : "";
  if (!nonce || nonce !== expectedNonce) {
    throw new Error("OAuth state validation failed.");
  }

  return {
    nonce,
    redirectUri:
      typeof state.redirectUri === "string" && state.redirectUri.trim()
        ? state.redirectUri.trim()
        : undefined,
  };
}

async function resolveTokenEndpoint(providerOrigin: string): Promise<string> {
  const wellKnownUrl = `${providerOrigin}/.well-known/openid-configuration`;

  try {
    const response = await fetch(wellKnownUrl, {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.ok) {
      const payload = (await response.json()) as { token_endpoint?: unknown };
      if (typeof payload.token_endpoint === "string" && payload.token_endpoint.trim()) {
        return payload.token_endpoint;
      }
    }
  } catch {
    // Fallback below.
  }

  return `${providerOrigin}/oauth/token`;
}

function resolveRedirectUri(
  configRedirect: string,
  stateRedirect: string | undefined,
  payloadRedirect: string | undefined,
): string {
  const candidate = payloadRedirect ?? stateRedirect ?? configRedirect;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("OAuth redirect URL is invalid.");
  }

  if (!url.pathname.endsWith("/oauth/callback")) {
    throw new Error("OAuth redirect URL is invalid.");
  }

  if (stateRedirect && stateRedirect !== candidate) {
    throw new Error("OAuth redirect URL mismatch.");
  }

  return candidate;
}

function extractProviderErrorDetail(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const payload = raw as {
    error?: unknown;
    error_description?: unknown;
    detail?: unknown;
    message?: unknown;
  };

  const candidate =
    payload.error_description ?? payload.detail ?? payload.message ?? payload.error;
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized.slice(0, 220) : null;
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const config = resolveHfOAuthConfig();
    if (!config.enabled || !config.clientId) {
      return jsonError(
        "Hugging Face OAuth is not configured on this deployment.",
        503,
      );
    }

    const payload = (await request.json()) as ExchangePayload;
    const code = payload.code?.trim();
    const stateRaw = payload.state?.trim();
    const cookiePkce = readHfOAuthPkceCookies(request);
    const sealedState = stateRaw ? tryParseHfOAuthStateToken(stateRaw) : null;
    const codeVerifier =
      payload.codeVerifier?.trim() || sealedState?.codeVerifier || cookiePkce.codeVerifier;
    const nonce = payload.nonce?.trim() || sealedState?.nonce || cookiePkce.nonce;

    if (!code || !stateRaw) {
      return jsonError("code and state are required.", 400);
    }

    if (!codeVerifier || !nonce) {
      return jsonError(
        "OAuth verifier state is missing. Start Hugging Face OAuth again and retry.",
        400,
      );
    }

    const state = sealedState ?? parseOAuthState(stateRaw, nonce);
    const redirectUri = resolveRedirectUri(
      resolveHfOAuthRedirectUrl(request.nextUrl.origin, config),
      state.redirectUri,
      payload.redirectUri?.trim(),
    );
    const providerOrigin = normalizeProviderOrigin(config.providerUrl);
    const tokenEndpoint = await resolveTokenEndpoint(providerOrigin);

    const exchangeBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: exchangeBody.toString(),
      cache: "no-store",
    });

    const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
      expires_at?: unknown;
      [key: string]: unknown;
    };

    if (!tokenResponse.ok) {
      const detail = extractProviderErrorDetail(tokenPayload);
      return jsonError(
        detail
          ? `Unable to complete Hugging Face OAuth exchange: ${detail}`
          : "Unable to complete Hugging Face OAuth exchange.",
        tokenResponse.status >= 400 && tokenResponse.status < 500 ? tokenResponse.status : 502,
      );
    }

    const accessToken =
      typeof tokenPayload.access_token === "string"
        ? tokenPayload.access_token.trim()
        : "";
    if (!accessToken) {
      return jsonError("OAuth exchange response did not include an access token.", 502);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresIn =
      typeof tokenPayload.expires_in === "number" && Number.isFinite(tokenPayload.expires_in)
        ? Math.floor(tokenPayload.expires_in)
        : null;
    const explicitExpiresAt =
      typeof tokenPayload.expires_at === "number" && Number.isFinite(tokenPayload.expires_at)
        ? Math.floor(tokenPayload.expires_at)
        : null;
    const expiresAt =
      expiresIn && expiresIn > 0
        ? nowSec + expiresIn
        : explicitExpiresAt && explicitExpiresAt > nowSec
          ? explicitExpiresAt
          : null;

    const sessionPayload = buildHfOAuthSessionPayload({
      accessToken,
      expiresAt,
    });
    const response = NextResponse.json({
      connected: true,
      expiresAt: sessionPayload.expiresAt,
    });
    setHfOAuthSessionCookie(response, sessionPayload);
    clearHfOAuthPkceCookies(response);

    return response;
  } catch (error) {
    if (error instanceof HfOAuthSessionError) {
      return jsonError(error.message, error.status);
    }

    if (error instanceof Error) {
      return jsonError(error.message, 400);
    }

    return jsonError("Unable to complete Hugging Face OAuth exchange.", 500);
  }
}
