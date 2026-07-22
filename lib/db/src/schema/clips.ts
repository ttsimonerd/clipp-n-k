import {
  pgTable,
  serial,
  integer,
  text,
  bigint,
  real,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const clipsTable = pgTable("clips", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  durationSeconds: real("duration_seconds"),
  width: integer("width"),
  height: integer("height"),
  storageKey: text("storage_key").notNull(),
  thumbnailKey: text("thumbnail_key"),
  // 'public' | 'private'
  visibility: text("visibility").notNull().default("private"),
  // 'processing' | 'ready' | 'failed'
  status: text("status").notNull().default("processing"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertClipSchema = createInsertSchema(clipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertClip = z.infer<typeof insertClipSchema>;
export type Clip = typeof clipsTable.$inferSelect;
