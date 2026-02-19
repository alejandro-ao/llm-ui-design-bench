// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/auth/hf/exchange/route";
import { buildHfOAuthStateToken } from "@/lib/hf-oauth-state";

const originalEnv = {
  HF_SESSION_COOKIE_SECRET: process.env.HF_SESSION_COOKIE_SECRET,
  HF_OAUTH_CLIENT_ID: process.env.HF_OAUTH_CLIENT_ID,
  HF_OAUTH_PROVIDER_URL: process.env.HF_OAUTH_PROVIDER_URL,
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
};

describe("POST /api/auth/hf/exchange", () => {
  beforeEach(() => {
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 17).toString("base64url");
    process.env.HF_OAUTH_CLIENT_ID = "hf_space_client";
    process.env.HF_OAUTH_PROVIDER_URL = "https://huggingface.co";
    delete process.env.OAUTH_CLIENT_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges code and sets oauth session cookie", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_endpoint: "https://huggingface.co/oauth/token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "hf_oauth_access_token",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "hf_oauth_nonce=nonce_123; hf_oauth_code_verifier=verifier_123",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: JSON.stringify({
            nonce: "nonce_123",
            redirectUri: "http://localhost/oauth/callback",
          }),
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connected: true,
    });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hf_oauth_session=");
    expect(setCookie).toContain("hf_oauth_nonce=;");
    expect(setCookie).toContain("hf_oauth_code_verifier=;");

    const tokenExchangeCall = fetchMock.mock.calls.at(1);
    expect(tokenExchangeCall?.[0]).toBe("https://huggingface.co/oauth/token");
    expect(String((tokenExchangeCall?.[1] as RequestInit | undefined)?.body)).toContain(
      "client_id=hf_space_client",
    );
  });

  it("rejects invalid oauth state", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "hf_oauth_nonce=nonce_123; hf_oauth_code_verifier=verifier_123",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: "not-json",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "OAuth state payload is invalid.",
    });
  });

  it("returns 503 when oauth is not configured", async () => {
    delete process.env.HF_OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_ID;

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "hf_oauth_nonce=nonce_123; hf_oauth_code_verifier=verifier_123",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: JSON.stringify({
            nonce: "nonce_123",
          }),
        }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Hugging Face OAuth is not configured on this deployment.",
    });
  });

  it("uses body nonce/codeVerifier when cookies are unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_endpoint: "https://huggingface.co/oauth/token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "hf_oauth_access_token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          codeVerifier: "verifier_123",
          nonce: "nonce_123",
          state: JSON.stringify({
            nonce: "nonce_123",
          }),
        }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("uses sealed oauth state token when cookies are unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_endpoint: "https://huggingface.co/oauth/token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "hf_oauth_access_token",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const stateToken = buildHfOAuthStateToken({
      nonce: "nonce_123",
      codeVerifier: "verifier_123",
      redirectUri: "http://localhost/oauth/callback",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: stateToken,
        }),
      }),
    );

    expect(response.status).toBe(200);
  });
});

afterEach(() => {
  if (originalEnv.HF_SESSION_COOKIE_SECRET === undefined) {
    delete process.env.HF_SESSION_COOKIE_SECRET;
  } else {
    process.env.HF_SESSION_COOKIE_SECRET = originalEnv.HF_SESSION_COOKIE_SECRET;
  }

  if (originalEnv.HF_OAUTH_CLIENT_ID === undefined) {
    delete process.env.HF_OAUTH_CLIENT_ID;
  } else {
    process.env.HF_OAUTH_CLIENT_ID = originalEnv.HF_OAUTH_CLIENT_ID;
  }

  if (originalEnv.HF_OAUTH_PROVIDER_URL === undefined) {
    delete process.env.HF_OAUTH_PROVIDER_URL;
  } else {
    process.env.HF_OAUTH_PROVIDER_URL = originalEnv.HF_OAUTH_PROVIDER_URL;
  }

  if (originalEnv.OAUTH_CLIENT_ID === undefined) {
    delete process.env.OAUTH_CLIENT_ID;
  } else {
    process.env.OAUTH_CLIENT_ID = originalEnv.OAUTH_CLIENT_ID;
  }
});
