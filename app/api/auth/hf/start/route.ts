import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { resolveHfOAuthConfig, resolveHfOAuthRedirectUrl } from "@/lib/hf-oauth-config";
import {
  buildHfOAuthAuthorizeUrl,
  createHfOAuthStartState,
  setHfOAuthPkceCookies,
} from "@/lib/hf-oauth-pkce";
import { buildHfOAuthStateToken } from "@/lib/hf-oauth-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectToStatus(request: NextRequest, status: string): NextResponse {
  const redirectUrl = new URL("/", request.nextUrl.origin);
  redirectUrl.searchParams.set("oauth", status);
  return NextResponse.redirect(redirectUrl);
}

function normalizeOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return "https://huggingface.co";
  }
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const config = resolveHfOAuthConfig();
  if (!config.enabled || !config.clientId) {
    console.warn("[api/auth/hf/start] oauth_disabled", {
      requestId,
      reason: "missing_client_id",
    });
    return redirectToStatus(request, "disabled");
  }

  const redirectUrl = resolveHfOAuthRedirectUrl(request.nextUrl.origin, config);
  const redirectOrigin = normalizeOrigin(redirectUrl);
  const providerOrigin = normalizeOrigin(config.providerUrl);

  const pkce = config.exchangeMethod === "pkce" ? createHfOAuthStartState() : null;
  const nonce = pkce?.nonce ?? randomUUID();
  const stateToken = buildHfOAuthStateToken({
    nonce,
    redirectUri: redirectUrl,
    codeVerifier: pkce?.codeVerifier,
  });

  console.info("[api/auth/hf/start] oauth_start_redirect", {
    requestId,
    exchangeMethod: config.exchangeMethod,
    providerOrigin,
    redirectOrigin,
  });

  const authorizeUrl = buildHfOAuthAuthorizeUrl({
    providerUrl: config.providerUrl,
    clientId: config.clientId,
    scopes: config.scopes,
    redirectUrl,
    state: stateToken,
    ...(pkce ? { codeChallenge: pkce.codeChallenge } : {}),
  });

  const response = NextResponse.redirect(authorizeUrl);
  if (pkce) {
    setHfOAuthPkceCookies(response, {
      nonce: pkce.nonce,
      codeVerifier: pkce.codeVerifier,
    });
  }
  return response;
}
