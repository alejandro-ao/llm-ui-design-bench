// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  buildHfOAuthStateToken,
  parseHfOAuthStateToken,
  validateHfOAuthStatePayload,
} from "@/lib/hf-oauth-state";

describe("hf oauth state token", () => {
  it("builds and parses a state token", () => {
    const token = buildHfOAuthStateToken({
      nonce: "nonce_123",
      codeVerifier: "verifier_123",
      redirectUri: "https://example.com/oauth/callback",
      issuedAt: 1700000000,
    });

    expect(token).toBeTruthy();
    const parsed = parseHfOAuthStateToken(token);
    expect(parsed).toEqual({
      v: 1,
      nonce: "nonce_123",
      codeVerifier: "verifier_123",
      redirectUri: "https://example.com/oauth/callback",
      issuedAt: 1700000000,
    });
  });

  it("validates redirect uri and ttl", () => {
    const payload = parseHfOAuthStateToken(
      buildHfOAuthStateToken({
        nonce: "nonce_123",
        redirectUri: "https://example.com/oauth/callback",
        issuedAt: 1700000000,
      }),
    );

    expect(() =>
      validateHfOAuthStatePayload(payload, "https://example.com/oauth/callback", {
        nowSeconds: 1700000300,
        maxAgeSeconds: 900,
      }),
    ).not.toThrow();

    expect(() =>
      validateHfOAuthStatePayload(payload, "https://example.com/other/callback", {
        nowSeconds: 1700000300,
        maxAgeSeconds: 900,
      }),
    ).toThrow("OAuth redirect URL mismatch.");

    expect(() =>
      validateHfOAuthStatePayload(payload, "https://example.com/oauth/callback", {
        nowSeconds: 1700005000,
        maxAgeSeconds: 900,
      }),
    ).toThrow("OAuth state expired. Start OAuth again.");
  });
});
