import { sql } from "drizzle-orm";
import { db, discordRolesTable, type DiscordRole, type SiteSettingsRow, type User } from "@workspace/db";
import { STAR_BONUS_BYTES } from "./github";

/**
 * Role-aware upload/storage limits.
 *
 * Precedence (highest wins):
 *   1. Per-user admin override (storage only) — `user.quotaOverrideBytes`.
 *   2. The configured Discord role with the highest `priority` among the
 *      roles the user currently holds, when that role sets the limit.
 *   3. The site-wide default from `site_settings`.
 *
 * The permanent +1 GB GitHub-star bonus is always added on top of whichever
 * storage base is chosen, so its semantics stay consistent regardless of
 * role/override configuration.
 *
 * Role config is cached briefly (and invalidated when the admin changes it)
 * to avoid a DB round-trip on every upload and /auth/me request.
 */

const ROLE_CONFIG_CACHE_TTL_MS = 30_000;

let roleConfigCache: { rows: DiscordRole[]; expiresAt: number } | null = null;

/** All configured role-limit rows, cached for a short window. */
export async function getRoleConfig(): Promise<DiscordRole[]> {
  const now = Date.now();
  if (roleConfigCache && roleConfigCache.expiresAt > now) {
    return roleConfigCache.rows;
  }
  const rows = await db
    .select()
    .from(discordRolesTable)
    .where(sql`TRUE`);
  roleConfigCache = { rows, expiresAt: now + ROLE_CONFIG_CACHE_TTL_MS };
  return rows;
}

/** Drops the cached role config (call after the admin updates it). */
export function invalidateRoleConfig(): void {
  roleConfigCache = null;
}

/** Picks the configured role with the highest priority among `userRoles`. */
function highestPriorityRole(
  roleConfig: DiscordRole[],
  userRoles: string[] | undefined | null,
): DiscordRole | undefined {
  const held = new Set(userRoles ?? []);
  return roleConfig
    .filter((r) => held.has(r.roleId))
    .sort((a, b) => b.priority - a.priority)[0];
}

/** Effective per-file upload size limit for a user. */
export function resolveUploadBytes(
  settings: Pick<SiteSettingsRow, "maxUploadBytes">,
  roleConfig: DiscordRole[],
  userRoles: string[] | undefined | null,
): number {
  const role = highestPriorityRole(roleConfig, userRoles);
  if (role?.maxUploadBytes != null) {
    return role.maxUploadBytes;
  }
  return settings.maxUploadBytes;
}

/** Effective storage quota for a user (base + star bonus). */
export function resolveQuotaBytes(
  settings: Pick<SiteSettingsRow, "maxUserStorageBytes">,
  roleConfig: DiscordRole[],
  user: Pick<User, "githubStarBonusGranted" | "quotaOverrideBytes" | "roles">,
): number {
  let base: number;
  if (user.quotaOverrideBytes != null) {
    base = user.quotaOverrideBytes;
  } else {
    const role = highestPriorityRole(roleConfig, user.roles);
    base = role?.maxUserStorageBytes ?? settings.maxUserStorageBytes;
  }
  return base + (user.githubStarBonusGranted ? STAR_BONUS_BYTES : 0);
}

export interface ResolvedLimits {
  quotaBytes: number;
  uploadBytes: number;
}

/**
 * Combined resolution: fetches the (cached) role config and returns both the
 * storage quota and per-file upload limit for a user. Single source of truth
 * used by the upload admission check and /auth/me so they never drift.
 */
export async function resolveUserLimits(
  user: Pick<User, "githubStarBonusGranted" | "quotaOverrideBytes" | "roles">,
  settings: Pick<SiteSettingsRow, "maxUploadBytes" | "maxUserStorageBytes">,
): Promise<ResolvedLimits> {
  const roleConfig = await getRoleConfig();
  return {
    quotaBytes: resolveQuotaBytes(settings, roleConfig, user),
    uploadBytes: resolveUploadBytes(settings, roleConfig, user.roles),
  };
}
