// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  DELETE,
  GET,
  POST,
} from "@/app/api/auth/hf/session/route";

const originalSecret = process.env.HF_SESSION_COOKIE_SECRET;
const originalSpaceHost = process.env.SPACE_HOST;

function extractCookieValue(setCookieHeader: string | null): string {
  if (!setCookieHeader) {
    throw new Error("Expected Set-Cookie header to be present.");
  }

  const firstPair = setCookieHeader.split(";")[0] ?? "";
  return firstPair.slice(firstPair.indexOf("=") + 1);
}

describe("HF OAuth session route", () => {
  beforeEach(() => {
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 9).toString("base64url");
    delete process.env.SPACE_HOST;
  });

  it("stores an oauth session and then reports connected", async () => {
    const postResponse = await POST(
      new NextRequest("http://localhost/api/auth/hf/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accessToken: "hf_oauth_access_token",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }),
      }),
    );

    expect(postResponse.status).toBe(200);
    await expect(postResponse.json()).resolves.toMatchObject({
      connected: true,
    });

    const cookieValue = extractCookieValue(postResponse.headers.get("set-cookie"));

    const getResponse = await GET(
      new NextRequest("http://localhost/api/auth/hf/session", {
        method: "GET",
        headers: {
          cookie: `hf_oauth_session=${cookieValue}`,
        },
      }),
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      connected: true,
    });
  });

  it("rejects expired tokens during session creation", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accessToken: "hf_oauth_access_token",
          expiresAt: Math.floor(Date.now() / 1000) - 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "OAuth access token is already expired.",
    });
  });

  it("disconnects by clearing the cookie", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connected: false,
    });
    expect(response.headers.get("set-cookie")).toContain("hf_oauth_session=");
  });

  it("uses SameSite=None secure cookies on Spaces deployments", async () => {
    process.env.SPACE_HOST = "owner-space.hf.space";

    const response = await POST(
      new NextRequest("http://localhost/api/auth/hf/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accessToken: "hf_oauth_access_token",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }),
      }),
    );

    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("SameSite=none");
    expect(setCookieHeader).toContain("Secure");
  });
});

afterAll(() => {
  if (originalSecret === undefined) {
    delete process.env.HF_SESSION_COOKIE_SECRET;
  } else {
    process.env.HF_SESSION_COOKIE_SECRET = originalSecret;
  }

  if (originalSpaceHost === undefined) {
    delete process.env.SPACE_HOST;
  } else {
    process.env.SPACE_HOST = originalSpaceHost;
  }
});
