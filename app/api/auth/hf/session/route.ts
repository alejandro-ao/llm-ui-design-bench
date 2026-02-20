import { NextRequest, NextResponse } from "next/server";

import {
  HfOAuthSessionError,
  buildHfOAuthSessionPayload,
  clearHfOAuthSessionCookie,
  getHfOAuthSessionFromCookies,
  setHfOAuthSessionCookie,
} from "@/lib/hf-oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionPayload {
  accessToken?: string;
  expiresAt?: number | null;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function parseExpiresAt(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HfOAuthSessionError(
      "expiresAt must be a unix timestamp (seconds) or null.",
      400,
      "invalid",
    );
  }

  return Math.floor(value);
}

export async function GET(request: NextRequest) {
  try {
    const session = getHfOAuthSessionFromCookies(request.cookies);
    if (!session) {
      return NextResponse.json({ connected: false });
    }

    return NextResponse.json({
      connected: true,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    if (error instanceof HfOAuthSessionError) {
      const response = NextResponse.json({ connected: false });
      if (error.reason === "invalid" || error.reason === "expired") {
        clearHfOAuthSessionCookie(response);
      }
      return response;
    }

    return NextResponse.json({ connected: false });
  }
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  try {
    const payload = (await request.json()) as SessionPayload;
    const accessToken = payload.accessToken?.trim();

    if (!accessToken) {
      return jsonError("accessToken is required.", 400);
    }

    const expiresAt = parseExpiresAt(payload.expiresAt);
    if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) {
      return jsonError("OAuth access token is already expired.", 400);
    }

    const sessionPayload = buildHfOAuthSessionPayload({
      accessToken,
      expiresAt,
    });

    const response = NextResponse.json({
      connected: true,
      expiresAt: sessionPayload.expiresAt,
    });
    setHfOAuthSessionCookie(response, sessionPayload);

    return response;
  } catch (error) {
    if (error instanceof HfOAuthSessionError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unable to persist Hugging Face OAuth session.", 500);
  }
}

export async function DELETE() {
  const response = NextResponse.json({ connected: false });
  clearHfOAuthSessionCookie(response);
  return response;
}
