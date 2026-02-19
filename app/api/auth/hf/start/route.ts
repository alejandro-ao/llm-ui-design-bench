import { NextRequest, NextResponse } from "next/server";

import { resolveHfOAuthConfig, resolveHfOAuthRedirectUrl } from "@/lib/hf-oauth-config";
import {
  buildHfOAuthAuthorizeUrl,
  createHfOAuthStartState,
  setHfOAuthPkceCookies,
} from "@/lib/hf-oauth-pkce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectToStatus(request: NextRequest, status: string): NextResponse {
  const redirectUrl = new URL("/", request.nextUrl.origin);
  redirectUrl.searchParams.set("oauth", status);
  return NextResponse.redirect(redirectUrl);
}

export async function GET(request: NextRequest) {
  const config = resolveHfOAuthConfig();
  if (!config.enabled || !config.clientId) {
    return redirectToStatus(request, "disabled");
  }

  const redirectUrl = resolveHfOAuthRedirectUrl(request.nextUrl.origin, config);
  const pkce = createHfOAuthStartState();
  const authorizeUrl = buildHfOAuthAuthorizeUrl({
    providerUrl: config.providerUrl,
    clientId: config.clientId,
    scopes: config.scopes,
    redirectUrl,
    nonce: pkce.nonce,
    codeChallenge: pkce.codeChallenge,
  });

  const response = NextResponse.redirect(authorizeUrl);
  setHfOAuthPkceCookies(response, {
    nonce: pkce.nonce,
    codeVerifier: pkce.codeVerifier,
  });
  return response;
}
