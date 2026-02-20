interface HfOAuthCookieBaseOptions {
  httpOnly: true;
  sameSite: "lax" | "none";
  secure: boolean;
  path: "/";
}

function isSpaceDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SPACE_HOST?.trim());
}

export function buildHfOAuthCookieBaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): HfOAuthCookieBaseOptions {
  if (isSpaceDeployment(env)) {
    return {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    };
  }

  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
  };
}
