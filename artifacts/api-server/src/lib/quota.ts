import { STAR_BONUS_BYTES } from "./github";
import type { User } from "@workspace/db";
import type { SiteSettingsRow } from "@workspace/db";

/**
 * Effective storage quota for a user: admin-configured base plus the
 * permanent +1 GB GitHub-star bonus if they've earned it.
 *
 * This is the single source of truth used by both the upload admission check
 * and the /auth/me response so the two never drift apart.
 */
export function effectiveQuotaBytes(user: Pick<User, "githubStarBonusGranted">, settings: Pick<SiteSettingsRow, "maxUserStorageBytes">): number {
  return settings.maxUserStorageBytes + (user.githubStarBonusGranted ? STAR_BONUS_BYTES : 0);
}
