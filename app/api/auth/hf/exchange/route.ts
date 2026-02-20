import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { resolveHfOAuthConfig, resolveHfOAuthRedirectUrl } from "@/lib/hf-oauth-config";
import { clearHfOAuthPkceCookies, readHfOAuthPkceCookies } from "@/lib/hf-oauth-pkce";
import {
  parseHfOAuthStateToken,
  validateHfOAuthStatePayload,
} from "@/lib/hf-oauth-state";
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
  stateFormat: "legacy_json" | "state_token";
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
    stateFormat: "legacy_json",
  };
}

function parseStateWithFallback(input: {
  rawState: string;
  expectedRedirectUri: string;
  fallbackNonce?: string;
}): ParsedOAuthState {
  const normalizedState = input.rawState.trim();
  if (!normalizedState) {
    throw new Error("OAuth state payload is invalid.");
  }

  if (normalizedState.startsWith("{")) {
    const fallbackNonce = input.fallbackNonce?.trim();
    if (!fallbackNonce) {
      throw new Error("OAuth state validation failed.");
    }

    const parsedLegacyState = parseOAuthState(normalizedState, fallbackNonce);
    if (
      parsedLegacyState.redirectUri &&
      parsedLegacyState.redirectUri !== input.expectedRedirectUri
    ) {
      throw new Error("OAuth redirect URL mismatch.");
    }
    return parsedLegacyState;
  }

  const parsedState = validateHfOAuthStatePayload(
    parseHfOAuthStateToken(normalizedState),
    input.expectedRedirectUri,
  );

    return {
      nonce: parsedState.nonce,
      redirectUri: parsedState.redirectUri,
      codeVerifier: parsedState.codeVerifier,
      stateFormat: "state_token",
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
  const requestId = randomUUID();
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const config = resolveHfOAuthConfig();
    if (!config.enabled || !config.clientId) {
      console.warn("[api/auth/hf/exchange] exchange_rejected_unconfigured", {
        requestId,
      });
      return jsonError(
        "Hugging Face OAuth is not configured on this deployment.",
        503,
      );
    }

    const payload = (await request.json()) as ExchangePayload;
    const code = payload.code?.trim();
    const stateRaw = payload.state?.trim();
    const cookiePkce = readHfOAuthPkceCookies(request);

    console.info("[api/auth/hf/exchange] exchange_request_received", {
      requestId,
      exchangeMethod: config.exchangeMethod,
      hasCode: Boolean(code),
      hasState: Boolean(stateRaw),
      stateChars: stateRaw?.length ?? 0,
      hasPayloadRedirectUri: Boolean(payload.redirectUri?.trim()),
      hasPayloadNonce: Boolean(payload.nonce?.trim()),
      hasPayloadCodeVerifier: Boolean(payload.codeVerifier?.trim()),
      hasCookieNonce: Boolean(cookiePkce.nonce),
      hasCookieCodeVerifier: Boolean(cookiePkce.codeVerifier),
      hasSessionCookieSecret: Boolean(process.env.HF_SESSION_COOKIE_SECRET?.trim()),
      hasSpaceOAuthClientSecret: Boolean(process.env.OAUTH_CLIENT_SECRET?.trim()),
      hasCustomOAuthClientSecret: Boolean(process.env.HF_OAUTH_CLIENT_SECRET?.trim()),
    });

    if (!code || !stateRaw) {
      console.warn("[api/auth/hf/exchange] exchange_rejected_missing_payload", {
        requestId,
      });
      return jsonError("code and state are required.", 400);
    }

    const configRedirectUri = resolveHfOAuthRedirectUrl(request.nextUrl.origin, config);
    let parsedState: ParsedOAuthState;
    try {
      parsedState = parseStateWithFallback({
        rawState: stateRaw,
        expectedRedirectUri: configRedirectUri,
        fallbackNonce: payload.nonce?.trim() || cookiePkce.nonce,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OAuth state payload is invalid.";
      console.warn("[api/auth/hf/exchange] exchange_state_invalid", {
        requestId,
        exchangeMethod: config.exchangeMethod,
        message,
      });
      return jsonError(message, 400);
    }

    console.info("[api/auth/hf/exchange] exchange_state_validated", {
      requestId,
      exchangeMethod: config.exchangeMethod,
      stateFormat: parsedState.stateFormat,
      hasStateRedirectUri: Boolean(parsedState.redirectUri),
      hasStateCodeVerifier: Boolean(parsedState.codeVerifier),
    });

    const redirectUri = resolveRedirectUri(
      configRedirectUri,
      parsedState.redirectUri,
      payload.redirectUri?.trim(),
    );
    const providerOrigin = normalizeProviderOrigin(config.providerUrl);
    const tokenEndpoint = await resolveTokenEndpoint(providerOrigin);

    console.info("[api/auth/hf/exchange] exchange_started", {
      requestId,
      exchangeMethod: config.exchangeMethod,
      providerOrigin,
      tokenEndpoint,
    });

    const exchangeBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };

    if (config.exchangeMethod === "client_secret") {
      if (!config.clientSecret) {
        console.warn("[api/auth/hf/exchange] exchange_rejected_missing_client_secret", {
          requestId,
        });
        return jsonError(
          "Hugging Face OAuth client secret is missing. Configure OAUTH_CLIENT_SECRET or HF_OAUTH_CLIENT_SECRET.",
          503,
        );
      }

      const basicAuth = Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
        "utf8",
      ).toString("base64");
      requestHeaders.Authorization = `Basic ${basicAuth}`;
    } else {
      const codeVerifier =
        payload.codeVerifier?.trim() ||
        parsedState.codeVerifier ||
        cookiePkce.codeVerifier;
      if (!codeVerifier) {
        console.warn("[api/auth/hf/exchange] exchange_rejected_missing_verifier", {
          requestId,
        });
        return jsonError(
          "OAuth verifier state is missing. Start Hugging Face OAuth again and retry.",
          400,
        );
      }

      exchangeBody.set("client_id", config.clientId);
      exchangeBody.set("code_verifier", codeVerifier);
    }

    console.info("[api/auth/hf/exchange] exchange_token_request", {
      requestId,
      exchangeMethod: config.exchangeMethod,
      tokenEndpoint,
      authMode: config.exchangeMethod === "client_secret" ? "basic" : "pkce",
      hasCodeVerifier: exchangeBody.has("code_verifier"),
      hasClientIdBodyParam: exchangeBody.has("client_id"),
    });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: requestHeaders,
      body: exchangeBody.toString(),
      cache: "no-store",
    });

    const tokenResponseContentType = tokenResponse.headers.get("content-type") ?? "";
    const tokenResponseText = await tokenResponse.text();
    let tokenPayload: {
      access_token?: unknown;
      expires_in?: unknown;
      expires_at?: unknown;
      [key: string]: unknown;
    } = {};

    if (tokenResponseText.trim()) {
      try {
        tokenPayload = JSON.parse(tokenResponseText) as {
          access_token?: unknown;
          expires_in?: unknown;
          expires_at?: unknown;
          [key: string]: unknown;
        };
      } catch {
        tokenPayload = {};
      }
    }

    if (!tokenResponse.ok) {
      const detail = extractProviderErrorDetail(tokenPayload);
      console.warn("[api/auth/hf/exchange] exchange_failed_upstream", {
        requestId,
        exchangeMethod: config.exchangeMethod,
        status: tokenResponse.status,
        providerDetail: detail,
        tokenResponseContentType,
        tokenResponseBodyChars: tokenResponseText.length,
        tokenResponseBodyPreview:
          detail || tokenResponseText.trim().slice(0, 160) || null,
      });
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
    console.info("[api/auth/hf/exchange] exchange_succeeded", {
      requestId,
      exchangeMethod: config.exchangeMethod,
      hasExpiry: sessionPayload.expiresAt !== null,
      sessionSecretSource: process.env.HF_SESSION_COOKIE_SECRET?.trim()
        ? "HF_SESSION_COOKIE_SECRET"
        : process.env.OAUTH_CLIENT_SECRET?.trim()
          ? "OAUTH_CLIENT_SECRET"
          : process.env.HF_OAUTH_CLIENT_SECRET?.trim()
            ? "HF_OAUTH_CLIENT_SECRET"
            : "missing",
    });

    return response;
  } catch (error) {
    if (error instanceof HfOAuthSessionError) {
      console.error("[api/auth/hf/exchange] exchange_failed_session", {
        requestId,
        status: error.status,
        reason: error.reason,
      });
      return jsonError(error.message, error.status);
    }

    if (error instanceof Error) {
      console.error("[api/auth/hf/exchange] exchange_failed", {
        requestId,
        message: error.message,
      });
      return jsonError(error.message, 400);
    }

    console.error("[api/auth/hf/exchange] exchange_failed_unknown", {
      requestId,
    });
    return jsonError("Unable to complete Hugging Face OAuth exchange.", 500);
  }
}
