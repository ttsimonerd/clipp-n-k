import { eq } from "drizzle-orm";
import { db, siteSettingsTable, type SiteSettingsRow } from "@workspace/db";

/** Reads the singleton settings row, creating it with defaults if missing. */
export async function getSiteSettings(): Promise<SiteSettingsRow> {
  const [existing] = await db
    .select()
    .from(siteSettingsTable)
    .where(eq(siteSettingsTable.id, 1));
  if (existing) {
    return existing;
  }
  const [created] = await db
    .insert(siteSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return created;
  }
  const [row] = await db
    .select()
    .from(siteSettingsTable)
    .where(eq(siteSettingsTable.id, 1));
  if (!row) {
    throw new Error("Failed to load or create site settings row");
  }
  return row;
}
