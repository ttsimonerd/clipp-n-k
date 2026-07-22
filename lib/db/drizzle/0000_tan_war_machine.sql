-- Initial schema migration.
-- Uses CREATE TABLE IF NOT EXISTS and exception-guarded ALTER TABLE so that
-- this file can be applied safely against a database that was previously
-- initialised by `drizzle-kit push`.  On a fresh database every statement
-- creates the objects from scratch; on an existing database the IF NOT EXISTS
-- clauses and the EXCEPTION handlers make every statement a no-op.

CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"username" text NOT NULL,
	"avatar_url" text,
	"used_storage_bytes" bigint DEFAULT 0 NOT NULL,
	"github_id" text,
	"github_username" text,
	"github_star_bonus_granted" boolean DEFAULT false NOT NULL,
	"github_access_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clips" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_seconds" real,
	"width" integer,
	"height" integer,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clips_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"discord_guild_id" text,
	"branding_title" text DEFAULT 'clipp''n''k' NOT NULL,
	"branding_logo_url" text,
	"branding_primary_color" text DEFAULT '#5865F2' NOT NULL,
	"max_upload_bytes" bigint DEFAULT 1073741824 NOT NULL,
	"max_user_storage_bytes" bigint DEFAULT 1073741824 NOT NULL,
	"max_clip_duration_seconds" integer,
	"allowed_mime_types" text[] DEFAULT '{"video/mp4","video/webm","video/quicktime","video/x-matroska"}' NOT NULL,
	"default_visibility" text DEFAULT 'private' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "clips" ADD CONSTRAINT "clips_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
