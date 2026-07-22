import { logger } from "./logger";

const DISCORD_API = "https://discord.com/api/v10";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for Discord OAuth to work.`);
  }
  return value;
}

export function getDiscordAuthorizeUrl(state: string): string {
  const clientId = getEnv("DISCORD_CLIENT_ID");
  const redirectUri = getEnv("DISCORD_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds",
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeDiscordCode(
  code: string,
): Promise<DiscordTokenResponse> {
  const clientId = getEnv("DISCORD_CLIENT_ID");
  const clientSecret = getEnv("DISCORD_CLIENT_SECRET");
  const redirectUri = getEnv("DISCORD_REDIRECT_URI");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error({ status: response.status, text }, "Discord token exchange failed");
    throw new Error("Discord token exchange failed");
  }

  return (await response.json()) as DiscordTokenResponse;
}

export interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error("Failed to fetch Discord user");
  }
  const data = (await response.json()) as DiscordUser;
  return data;
}

export function discordAvatarUrl(user: DiscordUser): string | null {
  if (!user.avatar) {
    return null;
  }
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

interface DiscordGuild {
  id: string;
  name: string;
}

/**
 * Validates a Discord bot token by calling the Discord API.
 *
 * Returns true if the token is accepted by Discord.
 * Returns false (and logs a warning) if the token is set but rejected —
 * e.g. revoked, malformed, or missing the required bot scope.
 * This prevents `discordBotEnabled` from reporting "Active" while silently
 * failing guild-membership checks.
 *
 * Results are cached for BOT_TOKEN_CACHE_TTL_MS to avoid hammering Discord
 * on every admin page load. The request is also bounded by BOT_TOKEN_TIMEOUT_MS
 * so a slow/unreachable Discord doesn't block the admin settings page.
 */
const BOT_TOKEN_TIMEOUT_MS = 3_000;
const BOT_TOKEN_CACHE_TTL_MS = 60_000;

interface BotTokenCacheEntry {
  token: string;
  result: boolean;
  expiresAt: number;
}

let botTokenCache: BotTokenCacheEntry | null = null;

export async function checkDiscordBotToken(token: string): Promise<boolean> {
  const now = Date.now();
  if (botTokenCache && botTokenCache.token === token && botTokenCache.expiresAt > now) {
    return botTokenCache.result;
  }

  const result = await checkDiscordBotTokenUncached(token);
  botTokenCache = { token, result, expiresAt: now + BOT_TOKEN_CACHE_TTL_MS };
  return result;
}

/** Exported for testing only — bypasses the cache. */
export async function checkDiscordBotTokenUncached(token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "DISCORD_BOT_TOKEN is set but Discord rejected it — guild membership checks will not work",
      );
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.warn(
        "DISCORD_BOT_TOKEN validation timed out — guild membership checks will not work",
      );
    } else {
      logger.warn(
        { err },
        "DISCORD_BOT_TOKEN validation request failed — guild membership checks will not work",
      );
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns true if the OAuth'd user is a member of `guildId`. */
export async function userIsInGuild(
  accessToken: string,
  guildId: string,
): Promise<boolean> {
  const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    logger.error({ status: response.status }, "Failed to fetch Discord guilds");
    throw new Error("Failed to fetch Discord guilds");
  }
  const guilds = (await response.json()) as DiscordGuild[];
  return guilds.some((guild) => guild.id === guildId);
}
