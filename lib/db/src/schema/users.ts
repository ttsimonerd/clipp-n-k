import { pgTable, serial, text, bigint, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull().unique(),
  username: text("username").notNull(),
  avatarUrl: text("avatar_url"),
  usedStorageBytes: bigint("used_storage_bytes", { mode: "number" })
    .notNull()
    .default(0),
  // GitHub account linked for star-bonus verification (not a login method).
  githubId: text("github_id").unique(),
  githubUsername: text("github_username"),
  // Set to true once the +1 GB star bonus has been permanently granted.
  // Idempotent: can never go back to false once true.
  githubStarBonusGranted: boolean("github_star_bonus_granted")
    .notNull()
    .default(false),
  // Persisted GitHub OAuth access token (read:user scope) used by check-star
  // so the re-check survives session expiry / server restarts.
  githubAccessToken: text("github_access_token"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
