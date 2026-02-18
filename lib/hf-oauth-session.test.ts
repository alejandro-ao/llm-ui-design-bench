import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  HfOAuthSessionError,
  buildHfOAuthSessionPayload,
  getHfOAuthSessionFromCookies,
  sealHfOAuthSession,
  unsealHfOAuthSession,
} from "@/lib/hf-oauth-session";

const originalSecret = process.env.HF_SESSION_COOKIE_SECRET;

describe("hf oauth session", () => {
  beforeEach(() => {
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 7).toString("base64url");
  });

  it("seals and unseals a valid session payload", () => {
    const payload = buildHfOAuthSessionPayload({
      accessToken: "hf_oauth_access_token",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      issuedAt: 1_700_000_000,
    });

    const sealed = sealHfOAuthSession(payload);
    const unsealed = unsealHfOAuthSession(sealed);

    expect(unsealed).toEqual(payload);
  });

  it("rejects tampered cookie payloads", () => {
    const payload = buildHfOAuthSessionPayload({
      accessToken: "hf_oauth_access_token",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    const sealed = sealHfOAuthSession(payload);
    const tampered = `${sealed.slice(0, -1)}A`;

    expect(() => unsealHfOAuthSession(tampered)).toThrow(HfOAuthSessionError);
  });

  it("fails to decrypt with a different secret", () => {
    const payload = buildHfOAuthSessionPayload({
      accessToken: "hf_oauth_access_token",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    const sealed = sealHfOAuthSession(payload);
    process.env.HF_SESSION_COOKIE_SECRET = Buffer.alloc(32, 3).toString("base64url");

    expect(() => unsealHfOAuthSession(sealed)).toThrow(HfOAuthSessionError);
  });

  it("treats expired sessions as invalid for request usage", () => {
    const payload = buildHfOAuthSessionPayload({
      accessToken: "hf_oauth_access_token",
      expiresAt: Math.floor(Date.now() / 1000) - 5,
    });

    const sealed = sealHfOAuthSession(payload);
    const cookies = {
      get: () => ({ value: sealed }),
    };

    expect(() => getHfOAuthSessionFromCookies(cookies)).toThrow(HfOAuthSessionError);
  });
});

afterAll(() => {
  if (originalSecret === undefined) {
    delete process.env.HF_SESSION_COOKIE_SECRET;
  } else {
    process.env.HF_SESSION_COOKIE_SECRET = originalSecret;
  }
});
