// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/auth/hf/start/route";

const originalEnv = {
  HF_SESSION_COOKIE_SECRET: process.env.HF_SESSION_COOKIE_SECRET,
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET,
  OAUTH_SCOPES: process.env.OAUTH_SCOPES,
  OPENID_PROVIDER_URL: process.env.OPENID_PROVIDER_URL,
  HF_OAUTH_CLIENT_ID: process.env.HF_OAUTH_CLIENT_ID,
  HF_OAUTH_CLIENT_SECRET: process.env.HF_OAUTH_CLIENT_SECRET,
  HF_OAUTH_SCOPES: process.env.HF_OAUTH_SCOPES,
  HF_OAUTH_PROVIDER_URL: process.env.HF_OAUTH_PROVIDER_URL,
  SPACE_HOST: process.env.SPACE_HOST,
  HF_PUBLIC_ORIGIN: process.env.HF_PUBLIC_ORIGIN,
};

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
  it("uses client-secret mode without pkce challenge/cookies when secret is available", async () => {
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    process.env.OAUTH_CLIENT_SECRET = "space_client_secret";
    process.env.OAUTH_SCOPES = "openid profile inference-api";
    process.env.OPENID_PROVIDER_URL = "https://huggingface.co";

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
    expect(authorizeUrl.searchParams.get("client_id")).toBe("space_client_id");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost/oauth/callback",
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBeNull();
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeNull();

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("hf_oauth_nonce=");
    expect(setCookie).not.toContain("hf_oauth_code_verifier=");
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

  it("uses pkce mode with challenge/cookies when secret is missing", async () => {
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.HF_OAUTH_CLIENT_SECRET;
    process.env.OAUTH_SCOPES = "openid profile";
    process.env.OPENID_PROVIDER_URL = "https://huggingface.co";

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/start", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const authorizeUrl = new URL(String(location));
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hf_oauth_nonce=");
    expect(setCookie).toContain("hf_oauth_code_verifier=");
  });

  it("uses SPACE_HOST in authorize redirect_uri when available", async () => {
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    process.env.OAUTH_CLIENT_SECRET = "space_client_secret";
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

  it("sets pkce cookies with SameSite=None on Spaces deployments", async () => {
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.HF_OAUTH_CLIENT_SECRET;
    process.env.OAUTH_SCOPES = "openid profile";
    process.env.OPENID_PROVIDER_URL = "https://huggingface.co";
    process.env.SPACE_HOST = "alejandro-ao-design-evals.hf.space";

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/start", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(307);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hf_oauth_nonce=");
    expect(setCookie).toContain("hf_oauth_code_verifier=");
    expect(setCookie).toContain("SameSite=none");
    expect(setCookie).toContain("Secure");
  });
});
