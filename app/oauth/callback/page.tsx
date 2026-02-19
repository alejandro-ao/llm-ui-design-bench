"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { oauthHandleRedirectIfPresent } from "@huggingface/hub";

interface OAuthConfigResponse {
  enabled: boolean;
  clientId: string | null;
  scopes: string[];
  providerUrl: string;
  redirectUrl: string;
}

const OAUTH_NONCE_STORAGE_KEY = "hf:oauth:nonce";
const OAUTH_CODE_VERIFIER_STORAGE_KEY = "hf:oauth:code_verifier";

function getStatusRedirect(status: string): string {
  return `/?oauth=${encodeURIComponent(status)}`;
}

function readOAuthPkcePair(): { nonce?: string; codeVerifier?: string } {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const nonce = window.sessionStorage.getItem(OAUTH_NONCE_STORAGE_KEY) ?? undefined;
    const codeVerifier =
      window.sessionStorage.getItem(OAUTH_CODE_VERIFIER_STORAGE_KEY) ?? undefined;
    return {
      nonce,
      codeVerifier,
    };
  } catch {
    return {};
  }
}

function clearOAuthPkcePair(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(OAUTH_NONCE_STORAGE_KEY);
    window.sessionStorage.removeItem(OAUTH_CODE_VERIFIER_STORAGE_KEY);
  } catch {
    // no-op
  }
}

export default function OAuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const run = async () => {
      try {
        const configResponse = await fetch("/api/auth/hf/config", { cache: "no-store" });
        if (!configResponse.ok) {
          router.replace(getStatusRedirect("error"));
          return;
        }

        const config = (await configResponse.json()) as OAuthConfigResponse;
        if (!config.enabled || !config.clientId) {
          router.replace(getStatusRedirect("disabled"));
          return;
        }

        const pkce = readOAuthPkcePair();
        const oauthResult = await oauthHandleRedirectIfPresent({
          hubUrl: config.providerUrl,
          nonce: pkce.nonce,
          codeVerifier: pkce.codeVerifier,
        });
        if (!oauthResult) {
          router.replace(getStatusRedirect("missing_code"));
          return;
        }

        const sessionResponse = await fetch("/api/auth/hf/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accessToken: oauthResult.accessToken,
            expiresAt: Math.floor(oauthResult.accessTokenExpiresAt.getTime() / 1000),
          }),
        });

        if (!sessionResponse.ok) {
          router.replace(getStatusRedirect("error"));
          return;
        }

        clearOAuthPkcePair();
        router.replace(getStatusRedirect("connected"));
      } catch {
        router.replace(getStatusRedirect("error"));
      }
    };

    void run();
  }, [router]);

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold text-foreground">Connecting to Hugging Face</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Finalizing OAuth session...
        </p>
      </div>
    </main>
  );
}
