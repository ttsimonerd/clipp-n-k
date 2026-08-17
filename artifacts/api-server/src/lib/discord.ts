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

// ── Bot-token operations (role sync + share-to-Discord) ──────────────────────

/**
 * Returns the configured bot token, or null when it is not set.
 *
 * The bot token is OPTIONAL: without it, role sync and "share to Discord"
 * are simply unavailable (the admin page already reports this), while
 * Discord OAuth login and guild-membership checks keep working. This is why
 * we return null rather than throwing like the OAuth getEnv() helper does.
 */
export function getDiscordBotToken(): string | null {
  return process.env.DISCORD_BOT_TOKEN?.trim() || null;
}

interface DiscordGuildRole {
  id: string;
  name: string;
  position: number;
}

/**
 * Lists every role in a guild. Requires a bot token with the guild present.
 * Used by the admin UI to map Discord roles to per-role upload/storage limits.
 */
export async function fetchGuildRoles(guildId: string): Promise<DiscordGuildRole[]> {
  const botToken = getDiscordBotToken();
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN must be set to fetch guild roles");
  }
  const response = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!response.ok) {
    logger.error({ status: response.status }, "Failed to fetch Discord guild roles");
    throw new Error(
      response.status === 404
        ? "Guild not found or the bot is not in it"
        : "Failed to fetch Discord guild roles",
    );
  }
  const roles = (await response.json()) as DiscordGuildRole[];
  // Discord returns the @everyone role first; the rest are already ordered by
  // descending position (highest at the top). Keep them as-is and let the
  // admin assign priorities explicitly.
  return roles;
}

/**
 * Fetches the role IDs a specific user has in a guild.
 *
 * Returns [] for a member with only the implicit @everyone role, and throws
 * (as 404) for a user who is not in the guild. Requires a bot token.
 */
export async function fetchMemberRoles(
  guildId: string,
  discordUserId: string,
): Promise<string[]> {
  const botToken = getDiscordBotToken();
  if (!botToken) {
    // No bot token → we can't resolve roles. Return [] (no role-based limits
    // apply) instead of throwing, so login still works without a bot.
    return [];
  }
  const response = await fetch(
    `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${botToken}` } },
  );
  if (!response.ok) {
    logger.error(
      { status: response.status, guildId, discordUserId },
      "Failed to fetch Discord member roles",
    );
    throw new Error("Failed to fetch Discord member roles");
  }
  const member = (await response.json()) as { roles?: string[] };
  return member.roles ?? [];
}

/**
 * Posts a message to a guild channel as the bot. Used by the "share to
 * Discord" feature. Throws on failure so the caller can surface an error.
 */
export async function postChannelMessage(
  channelId: string,
  content: string,
): Promise<void> {
  const botToken = getDiscordBotToken();
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN must be set to post to Discord");
  }
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const text = await response.text();
    logger.error({ status: response.status, text }, "Failed to post message to Discord channel");
    throw new Error(
      response.status === 403
        ? "The bot lacks permission to post in that channel"
        : "Failed to post message to Discord channel",
    );
  }
}
