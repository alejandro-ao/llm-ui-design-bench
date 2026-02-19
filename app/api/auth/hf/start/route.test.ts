// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/auth/hf/start/route";

const originalEnv = {
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
  OAUTH_SCOPES: process.env.OAUTH_SCOPES,
  OPENID_PROVIDER_URL: process.env.OPENID_PROVIDER_URL,
  HF_OAUTH_CLIENT_ID: process.env.HF_OAUTH_CLIENT_ID,
  HF_OAUTH_SCOPES: process.env.HF_OAUTH_SCOPES,
  HF_OAUTH_PROVIDER_URL: process.env.HF_OAUTH_PROVIDER_URL,
  SPACE_HOST: process.env.SPACE_HOST,
  HF_PUBLIC_ORIGIN: process.env.HF_PUBLIC_ORIGIN,
};

afterEach(() => {
  if (originalEnv.OAUTH_CLIENT_ID === undefined) {
    delete process.env.OAUTH_CLIENT_ID;
  } else {
    process.env.OAUTH_CLIENT_ID = originalEnv.OAUTH_CLIENT_ID;
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

  if (originalEnv.HF_OAUTH_SCOPES === undefined) {
    delete process.env.HF_OAUTH_SCOPES;
  } else {
    process.env.HF_OAUTH_SCOPES = originalEnv.HF_OAUTH_SCOPES;
  }

  if (originalEnv.HF_OAUTH_PROVIDER_URL === undefined) {
    delete process.env.HF_OAUTH_PROVIDER_URL;
  } else {
    process.env.HF_OAUTH_PROVIDER_URL = originalEnv.HF_OAUTH_PROVIDER_URL;
  }

  if (originalEnv.SPACE_HOST === undefined) {
    delete process.env.SPACE_HOST;
  } else {
    process.env.SPACE_HOST = originalEnv.SPACE_HOST;
  }

  if (originalEnv.HF_PUBLIC_ORIGIN === undefined) {
    delete process.env.HF_PUBLIC_ORIGIN;
  } else {
    process.env.HF_PUBLIC_ORIGIN = originalEnv.HF_PUBLIC_ORIGIN;
  }
});

describe("GET /api/auth/hf/start", () => {
  it("redirects to provider authorize endpoint and sets pkce cookies", async () => {
    process.env.HF_OAUTH_CLIENT_ID = "hf_custom_client";
    process.env.HF_OAUTH_SCOPES = "openid profile inference-api";
    process.env.HF_OAUTH_PROVIDER_URL = "https://huggingface.co";
    delete process.env.OAUTH_CLIENT_ID;

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/start", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const authorizeUrl = new URL(String(location));
    expect(authorizeUrl.origin).toBe("https://huggingface.co");
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("hf_custom_client");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost/oauth/callback",
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hf_oauth_nonce=");
    expect(setCookie).toContain("hf_oauth_code_verifier=");
  });

  it("redirects to disabled state when oauth is not configured", async () => {
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.HF_OAUTH_CLIENT_ID;

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/start", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/?oauth=disabled");
  });

  it("uses SPACE_HOST in authorize redirect_uri when available", async () => {
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    process.env.OAUTH_SCOPES = "openid profile";
    process.env.OPENID_PROVIDER_URL = "https://huggingface.co";
    process.env.SPACE_HOST = "alejandro-ao-design-evals.hf.space";
    delete process.env.HF_PUBLIC_ORIGIN;

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/start", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const authorizeUrl = new URL(String(location));
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://alejandro-ao-design-evals.hf.space/oauth/callback",
    );
  });
});
