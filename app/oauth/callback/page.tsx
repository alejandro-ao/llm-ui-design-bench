"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

function getStatusRedirect(status: string): string {
  return `/?oauth=${encodeURIComponent(status)}`;
}

export default function OAuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const run = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("error")) {
          router.replace(getStatusRedirect("error"));
          return;
        }

        const code = params.get("code");
        if (!code) {
          router.replace(getStatusRedirect("missing_code"));
          return;
        }

        const stateRaw = params.get("state");
        if (!stateRaw) {
          router.replace(getStatusRedirect("missing_state"));
          return;
        }

        const exchangeResponse = await fetch("/api/auth/hf/exchange", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            state: stateRaw,
          }),
        });

        if (!exchangeResponse.ok) {
          const payload = (await exchangeResponse.json().catch(() => null)) as {
            error?: string;
          } | null;
          if (
            typeof payload?.error === "string" &&
            payload.error.toLowerCase().includes("verifier state is missing")
          ) {
            router.replace(getStatusRedirect("missing_pkce"));
            return;
          }
          router.replace(getStatusRedirect("exchange_failed"));
          return;
        }

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
