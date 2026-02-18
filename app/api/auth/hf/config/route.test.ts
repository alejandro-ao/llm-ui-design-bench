// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/auth/hf/config/route";

const originalEnv = {
  OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
  OAUTH_SCOPES: process.env.OAUTH_SCOPES,
  OPENID_PROVIDER_URL: process.env.OPENID_PROVIDER_URL,
  HF_OAUTH_CLIENT_ID: process.env.HF_OAUTH_CLIENT_ID,
  HF_OAUTH_SCOPES: process.env.HF_OAUTH_SCOPES,
  HF_OAUTH_PROVIDER_URL: process.env.HF_OAUTH_PROVIDER_URL,
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
});

describe("GET /api/auth/hf/config", () => {
  it("uses Spaces OAuth env when present", async () => {
    process.env.OAUTH_CLIENT_ID = "space_client_id";
    process.env.OAUTH_SCOPES = "openid profile";
    process.env.OPENID_PROVIDER_URL = "https://huggingface.co";
    process.env.HF_OAUTH_CLIENT_ID = "custom_client_id";

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/config", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      enabled: boolean;
      mode: string;
      clientId: string | null;
      providerUrl: string;
      redirectUrl: string;
      scopes: string[];
    };

    expect(payload).toMatchObject({
      enabled: true,
      mode: "space",
      clientId: "space_client_id",
      providerUrl: "https://huggingface.co",
      redirectUrl: "http://localhost/oauth/callback",
    });
    expect(payload.scopes).toContain("inference-api");
  });

  it("falls back to custom OAuth env values", async () => {
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_SCOPES;
    delete process.env.OPENID_PROVIDER_URL;
    process.env.HF_OAUTH_CLIENT_ID = "custom_client_id";
    process.env.HF_OAUTH_SCOPES = "openid profile inference-api";
    process.env.HF_OAUTH_PROVIDER_URL = "https://huggingface.co";

    const response = await GET(
      new NextRequest("http://localhost/api/auth/hf/config", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      mode: "custom",
      clientId: "custom_client_id",
      providerUrl: "https://huggingface.co",
    });
  });
});
