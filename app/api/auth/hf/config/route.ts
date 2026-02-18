import { NextRequest, NextResponse } from "next/server";

import { resolveHfOAuthConfig, resolveHfOAuthRedirectUrl } from "@/lib/hf-oauth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = resolveHfOAuthConfig();
  const redirectUrl = resolveHfOAuthRedirectUrl(request.nextUrl.origin, config);

  return NextResponse.json({
    enabled: config.enabled,
    mode: config.mode,
    clientId: config.clientId,
    scopes: config.scopes,
    providerUrl: config.providerUrl,
    redirectUrl,
  });
}
