import { pgTable, integer, text, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Singleton table -- always exactly one row with id = 1.
export const siteSettingsTable = pgTable("site_settings", {
  id: integer("id").primaryKey().default(1),
  discordGuildId: text("discord_guild_id"),
  brandingTitle: text("branding_title").notNull().default("clipp'n'k"),
  brandingLogoUrl: text("branding_logo_url"),
  brandingPrimaryColor: text("branding_primary_color")
    .notNull()
    .default("#5865F2"),
  maxUploadBytes: bigint("max_upload_bytes", { mode: "number" })
    .notNull()
    .default(1_073_741_824),
  maxUserStorageBytes: bigint("max_user_storage_bytes", { mode: "number" })
    .notNull()
    .default(1_073_741_824),
  maxClipDurationSeconds: integer("max_clip_duration_seconds"),
  allowedMimeTypes: text("allowed_mime_types")
    .array()
    .notNull()
    .default([
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
    ]),
  // 'public' | 'private'
  defaultVisibility: text("default_visibility").notNull().default("private"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertSiteSettingsSchema = createInsertSchema(
  siteSettingsTable,
).omit({ id: true, updatedAt: true });
export type InsertSiteSettings = z.infer<typeof insertSiteSettingsSchema>;
export type SiteSettingsRow = typeof siteSettingsTable.$inferSelect;
