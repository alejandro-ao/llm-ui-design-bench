import type { NextRequest } from "next/server";

import { HfOAuthSessionError, getHfOAuthSessionFromCookies } from "@/lib/hf-oauth-session";

export const HF_AUTH_MISSING_MESSAGE =
  "Provide hfApiKey or connect with Hugging Face OAuth.";
export const HF_AUTH_RECONNECT_MESSAGE =
  "Hugging Face OAuth session is invalid or expired. Reconnect with Hugging Face OAuth.";

export class HfCredentialError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HfCredentialError";
    this.status = status;
  }
}

export function resolveHfApiKeyFromRequest(
  request: NextRequest,
  hfApiKeyFromPayload: string | undefined,
): string {
  const manualKey = hfApiKeyFromPayload?.trim();
  if (manualKey) {
    return manualKey;
  }

  try {
    const session = getHfOAuthSessionFromCookies(request.cookies);
    if (!session) {
      throw new HfCredentialError(HF_AUTH_MISSING_MESSAGE, 400);
    }

    return session.accessToken;
  } catch (error) {
    if (error instanceof HfCredentialError) {
      throw error;
    }

    if (error instanceof HfOAuthSessionError) {
      if (error.reason === "invalid" || error.reason === "expired") {
        throw new HfCredentialError(HF_AUTH_RECONNECT_MESSAGE, 401);
      }

      throw new HfCredentialError(
        "Hugging Face OAuth is not configured on this server.",
        500,
      );
    }

    throw error;
  }
}
