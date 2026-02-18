const DEFAULT_PROVIDER_URL = "https://huggingface.co";
const DEFAULT_SCOPES = ["openid", "profile", "inference-api"];
const REDIRECT_PATH = "/oauth/callback";

export type HfOAuthMode = "space" | "custom";

export interface HfOAuthConfig {
  enabled: boolean;
  mode: HfOAuthMode;
  clientId: string | null;
  scopes: string[];
  providerUrl: string;
  redirectPath: typeof REDIRECT_PATH;
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
    scopes: parseScopes(scopesInput),
    providerUrl: normalizeProviderUrl(providerInput),
    redirectPath: REDIRECT_PATH,
  };
}

export function resolveHfOAuthRedirectUrl(origin: string, config = resolveHfOAuthConfig()): string {
  return new URL(config.redirectPath, origin).toString();
}
