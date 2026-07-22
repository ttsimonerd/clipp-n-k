import { logger } from "./logger";

const GITHUB_API = "https://api.github.com";

// The repo whose star is verified for the +1 GB bonus.
const BONUS_REPO_OWNER = "ttsimonerd";
const BONUS_REPO_NAME = "clipp-n-k";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for GitHub OAuth to work.`);
  }
  return value;
}

export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export function getGithubAuthorizeUrl(state: string): string {
  const clientId = getEnv("GITHUB_CLIENT_ID");
  const redirectUri = getEnv("GITHUB_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

interface GithubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export async function exchangeGithubCode(code: string): Promise<GithubTokenResponse> {
  const clientId = getEnv("GITHUB_CLIENT_ID");
  const clientSecret = getEnv("GITHUB_CLIENT_SECRET");
  const redirectUri = getEnv("GITHUB_REDIRECT_URI");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error({ status: response.status, text }, "GitHub token exchange failed");
    throw new Error("GitHub token exchange failed");
  }

  const data = (await response.json()) as GithubTokenResponse & { error?: string };
  if (data.error) {
    logger.error({ error: data.error }, "GitHub returned error during token exchange");
    throw new Error(`GitHub OAuth error: ${data.error}`);
  }
  return data;
}

export interface GithubUser {
  id: number;
  login: string;
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error("Failed to fetch GitHub user");
  }
  return (await response.json()) as GithubUser;
}

/**
 * Thrown when the stored GitHub access token has been revoked or is otherwise
 * invalid (GitHub returns 401). Callers should clear the token and prompt
 * the user to re-link their GitHub account.
 */
export class GithubTokenInvalidError extends Error {
  constructor() {
    super("GitHub access token is invalid or has been revoked");
    this.name = "GithubTokenInvalidError";
  }
}

/**
 * Thrown when GitHub rate-limits the star-check request (HTTP 429).
 * Callers should surface a "try again shortly" message rather than a server error.
 */
export class GithubRateLimitError extends Error {
  constructor() {
    super("GitHub API rate limit exceeded");
    this.name = "GithubRateLimitError";
  }
}

/**
 * Returns true if the authenticated GitHub user has starred BONUS_REPO_OWNER/BONUS_REPO_NAME.
 * GitHub returns 204 (starred) or 404 (not starred).
 * Throws GithubTokenInvalidError on 401 (token revoked/expired).
 * Throws GithubRateLimitError on 429 (rate limit exceeded).
 */
export async function checkHasStarred(accessToken: string): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/user/starred/${BONUS_REPO_OWNER}/${BONUS_REPO_NAME}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (response.status === 204) return true;
  if (response.status === 404) return false;
  if (response.status === 401) {
    logger.warn("GitHub token invalid or revoked during star check");
    throw new GithubTokenInvalidError();
  }
  if (response.status === 429) {
    logger.warn("GitHub API rate limit exceeded during star check");
    throw new GithubRateLimitError();
  }
  logger.error({ status: response.status }, "Unexpected response from GitHub star check");
  throw new Error("Star check failed");
}

export const STAR_BONUS_BYTES = 1_073_741_824; // 1 GB
