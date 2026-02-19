const DEFAULT_PROVIDER_URL = "https://huggingface.co";
const DEFAULT_SCOPES = ["openid", "profile", "inference-api"];
const REDIRECT_PATH = "/oauth/callback";

export type HfOAuthMode = "space" | "custom";

export interface HfOAuthConfig {
  enabled: boolean;
  mode: HfOAuthMode;
  clientId: string | null;
  clientSecret: string | null;
  exchangeMethod: "client_secret" | "pkce";
  scopes: string[];
  providerUrl: string;
  redirectPath: typeof REDIRECT_PATH;
}

function normalizeOrigin(input: string | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function normalizeSpaceHostOrigin(input: string | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!withoutProtocol) {
    return null;
  }

  return `https://${withoutProtocol}`;
}

function normalizeProviderUrl(input: string | undefined): string {
  const trimmed = input?.trim();
  if (!trimmed) {
    return DEFAULT_PROVIDER_URL;
  }

  try {
    const url = new URL(trimmed);
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || ""}`;
  } catch {
    return DEFAULT_PROVIDER_URL;
  }
}

function parseScopes(scopesInput: string | undefined): string[] {
  const parsed = (scopesInput ?? "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const uniqueScopes = [...new Set(parsed)];
  if (!uniqueScopes.some((scope) => scope.toLowerCase() === "inference-api")) {
    uniqueScopes.push("inference-api");
  }

  return uniqueScopes.length > 0 ? uniqueScopes : [...DEFAULT_SCOPES];
}

export function resolveHfOAuthConfig(env: NodeJS.ProcessEnv = process.env): HfOAuthConfig {
  const spaceClientId = env.OAUTH_CLIENT_ID?.trim();
  const customClientId = env.HF_OAUTH_CLIENT_ID?.trim();
  const usesSpaceConfig = Boolean(spaceClientId);
  const clientId = spaceClientId || customClientId || null;
  const clientSecret = usesSpaceConfig
    ? env.OAUTH_CLIENT_SECRET?.trim() || env.HF_OAUTH_CLIENT_SECRET?.trim() || null
    : env.HF_OAUTH_CLIENT_SECRET?.trim() || null;

  const scopesInput = usesSpaceConfig
    ? env.OAUTH_SCOPES ?? env.HF_OAUTH_SCOPES
    : env.HF_OAUTH_SCOPES;

  const providerInput = usesSpaceConfig
    ? env.OPENID_PROVIDER_URL ?? env.HF_OAUTH_PROVIDER_URL
    : env.HF_OAUTH_PROVIDER_URL;

  return {
    enabled: Boolean(clientId),
    mode: usesSpaceConfig ? "space" : "custom",
    clientId,
    clientSecret,
    exchangeMethod: clientSecret ? "client_secret" : "pkce",
    scopes: parseScopes(scopesInput),
    providerUrl: normalizeProviderUrl(providerInput),
    redirectPath: REDIRECT_PATH,
  };
}

export function resolveHfOAuthRedirectUrl(
  origin: string,
  config = resolveHfOAuthConfig(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitPublicOrigin = normalizeOrigin(env.HF_PUBLIC_ORIGIN);
  const spaceHostOrigin = normalizeSpaceHostOrigin(env.SPACE_HOST);
  const baseOrigin = explicitPublicOrigin || spaceHostOrigin || origin;
  return new URL(config.redirectPath, baseOrigin).toString();
}
