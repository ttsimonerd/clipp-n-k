-- Discord role sync + per-role limits + user admin columns.
-- Follows the same idempotent pattern as 0000: CREATE TABLE IF NOT EXISTS and
-- exception-guarded ALTER TABLE so it is safe to re-apply against a database
-- that was previously updated via `drizzle-kit push`.

DO $$ BEGIN
	ALTER TABLE "users" ADD COLUMN "roles" text[] DEFAULT '{}' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" ADD COLUMN "quota_override_bytes" bigint;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discord_roles" (
	"role_id" text PRIMARY KEY NOT NULL,
	"role_name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_upload_bytes" bigint,
	"max_user_storage_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "site_settings" ADD COLUMN "discord_share_channel_id" text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
