// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/auth/hf/exchange/route";
import { buildHfOAuthStateToken } from "@/lib/hf-oauth-state";

const originalEnv = {
  HF_SESSION_COOKIE_SECRET: process.env.HF_SESSION_COOKIE_SECRET,
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET,
  OAUTH_SCOPES: process.env.OAUTH_SCOPES,
  OPENID_PROVIDER_URL: process.env.OPENID_PROVIDER_URL,
  HF_OAUTH_CLIENT_ID: process.env.HF_OAUTH_CLIENT_ID,
  HF_OAUTH_CLIENT_SECRET: process.env.HF_OAUTH_CLIENT_SECRET,
  HF_OAUTH_PROVIDER_URL: process.env.HF_OAUTH_PROVIDER_URL,
};

describe("POST /api/auth/hf/exchange", () => {
  beforeEach(() => {
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 17).toString("base64url");
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    process.env.OAUTH_CLIENT_SECRET = "space_client_secret";
    process.env.OAUTH_SCOPES = "openid profile inference-api";
    process.env.OPENID_PROVIDER_URL = "https://huggingface.co";
    delete process.env.HF_OAUTH_CLIENT_ID;
    delete process.env.HF_OAUTH_CLIENT_SECRET;
    delete process.env.HF_OAUTH_PROVIDER_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses client-secret exchange with basic auth and sets oauth session cookie", async () => {
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

    const stateToken = buildHfOAuthStateToken({
      nonce: "nonce_123",
      redirectUri: "http://localhost/oauth/callback",
      issuedAt: Math.floor(Date.now() / 1000),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "hf_oauth_nonce=nonce_legacy; hf_oauth_code_verifier=verifier_legacy",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: stateToken,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connected: true,
    });

    const tokenExchangeCall = fetchMock.mock.calls.at(1);
    expect(tokenExchangeCall?.[0]).toBe("https://huggingface.co/oauth/token");

    const requestInit = (tokenExchangeCall?.[1] as RequestInit | undefined) ?? {};
    const headers = requestInit.headers as Record<string, string> | undefined;
    const authHeader = headers?.Authorization ?? headers?.authorization;
    const expectedAuth = `Basic ${Buffer.from("space_client_id:space_client_secret").toString("base64")}`;
    expect(authHeader).toBe(expectedAuth);

    const body = String(requestInit.body ?? "");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=oauth_code_123");
    expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost%2Foauth%2Fcallback");
    expect(body).not.toContain("code_verifier");
    expect(body).not.toContain("client_id");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hf_oauth_session=");
    expect(setCookie).toContain("hf_oauth_nonce=;");
    expect(setCookie).toContain("hf_oauth_code_verifier=;");
  });

  it("returns sanitized provider detail when client-secret exchange fails", async () => {
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
            error_description: "Invalid authorization code",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const stateToken = buildHfOAuthStateToken({
      nonce: "nonce_123",
      redirectUri: "http://localhost/oauth/callback",
      issuedAt: Math.floor(Date.now() / 1000),
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

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unable to complete Hugging Face OAuth exchange: Invalid authorization code",
    });
  });

  it("falls back to pkce exchange when no client secret is available", async () => {
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.HF_OAUTH_CLIENT_SECRET;

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
      codeVerifier: "verifier_from_state",
      redirectUri: "http://localhost/oauth/callback",
      issuedAt: Math.floor(Date.now() / 1000),
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

    const tokenExchangeCall = fetchMock.mock.calls.at(1);
    const body = String(((tokenExchangeCall?.[1] as RequestInit | undefined)?.body) ?? "");
    expect(body).toContain("client_id=space_client_id");
    expect(body).toContain("code_verifier=verifier_from_state");
  });

  it("rejects invalid, mismatched, and expired state tokens", async () => {
    const invalidResponse = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: "not_base64_state",
        }),
      }),
    );
    expect(invalidResponse.status).toBe(400);

    const mismatchedState = buildHfOAuthStateToken({
      nonce: "nonce_123",
      redirectUri: "http://localhost/other/callback",
      issuedAt: Math.floor(Date.now() / 1000),
    });
    const mismatchResponse = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: mismatchedState,
        }),
      }),
    );
    expect(mismatchResponse.status).toBe(400);
    await expect(mismatchResponse.json()).resolves.toMatchObject({
      error: "OAuth redirect URL mismatch.",
    });

    const expiredState = buildHfOAuthStateToken({
      nonce: "nonce_123",
      redirectUri: "http://localhost/oauth/callback",
      issuedAt: Math.floor(Date.now() / 1000) - 3600,
    });
    const expiredResponse = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: expiredState,
        }),
      }),
    );
    expect(expiredResponse.status).toBe(400);
    await expect(expiredResponse.json()).resolves.toMatchObject({
      error: "OAuth state expired. Start OAuth again.",
    });
  });

  it("returns 503 when oauth is not configured", async () => {
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.HF_OAUTH_CLIENT_ID;

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "oauth_code_123",
          state: buildHfOAuthStateToken({
            nonce: "nonce_123",
            redirectUri: "http://localhost/oauth/callback",
            issuedAt: Math.floor(Date.now() / 1000),
          }),
        }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Hugging Face OAuth is not configured on this deployment.",
    });
  });
});

afterEach(() => {
  if (originalEnv.HF_SESSION_COOKIE_SECRET === undefined) {
    delete process.env.HF_SESSION_COOKIE_SECRET;
  } else {
    process.env.HF_SESSION_COOKIE_SECRET = originalEnv.HF_SESSION_COOKIE_SECRET;
  }

  if (originalEnv.OAUTH_CLIENT_ID === undefined) {
    delete process.env.OAUTH_CLIENT_ID;
  } else {
    process.env.OAUTH_CLIENT_ID = originalEnv.OAUTH_CLIENT_ID;
  }

  if (originalEnv.OAUTH_CLIENT_SECRET === undefined) {
    delete process.env.OAUTH_CLIENT_SECRET;
  } else {
    process.env.OAUTH_CLIENT_SECRET = originalEnv.OAUTH_CLIENT_SECRET;
  }

  if (originalEnv.OAUTH_SCOPES === undefined) {
    delete process.env.OAUTH_SCOPES;
  } else {
    process.env.OAUTH_SCOPES = originalEnv.OAUTH_SCOPES;
  }

  if (originalEnv.OPENID_PROVIDER_URL === undefined) {
    delete process.env.OPENID_PROVIDER_URL;
  } else {
    process.env.OPENID_PROVIDER_URL = originalEnv.OPENID_PROVIDER_URL;
  }

  if (originalEnv.HF_OAUTH_CLIENT_ID === undefined) {
    delete process.env.HF_OAUTH_CLIENT_ID;
  } else {
    process.env.HF_OAUTH_CLIENT_ID = originalEnv.HF_OAUTH_CLIENT_ID;
  }

  if (originalEnv.HF_OAUTH_CLIENT_SECRET === undefined) {
    delete process.env.HF_OAUTH_CLIENT_SECRET;
  } else {
    process.env.HF_OAUTH_CLIENT_SECRET = originalEnv.HF_OAUTH_CLIENT_SECRET;
  }

  if (originalEnv.HF_OAUTH_PROVIDER_URL === undefined) {
    delete process.env.HF_OAUTH_PROVIDER_URL;
  } else {
    process.env.HF_OAUTH_PROVIDER_URL = originalEnv.HF_OAUTH_PROVIDER_URL;
  }
});
