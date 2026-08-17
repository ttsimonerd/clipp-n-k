import { pgTable, text, integer, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Per-Discord-role upload/storage limits.
 *
 * When a user has several configured roles, the role with the highest
 * `priority` wins. Null `max_upload_bytes` / `max_user_storage_bytes` mean
 * "inherit the site-wide default" — so a role only needs to set the values it
 * wants to change.
 */
export const discordRolesTable = pgTable("discord_roles", {
  roleId: text("role_id").primaryKey(),
  roleName: text("role_name").notNull(),
  priority: integer("priority").notNull().default(0),
  maxUploadBytes: bigint("max_upload_bytes", { mode: "number" }),
  maxUserStorageBytes: bigint("max_user_storage_bytes", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertDiscordRoleSchema = createInsertSchema(discordRolesTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertDiscordRole = z.infer<typeof insertDiscordRoleSchema>;
export type DiscordRole = typeof discordRolesTable.$inferSelect;
