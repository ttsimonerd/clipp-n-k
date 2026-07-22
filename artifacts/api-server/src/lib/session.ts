import session from "express-session";
import pgSession from "connect-pg-simple";
import { pool } from "@workspace/db";

const PgStore = pgSession(session);

// NOTE: createTableIfMissing is intentionally NOT used -- connect-pg-simple
// reads its bundled table.sql template via a path relative to its own
// package directory, which breaks once this server is esbuild-bundled into
// a single dist/index.mjs file (the template file isn't copied alongside
// it). We create the table ourselves in ensureSessionTable() instead.
export const sessionMiddleware = session({
  store: new PgStore({
    pool,
    tableName: "session",
    createTableIfMissing: false,
  }),
  // validateEnv() in lib/env.ts guarantees SESSION_SECRET is set before this
  // module is reached, so the non-null assertion is safe.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  name: "clippnk.sid",
  cookie: {
    httpOnly: true,
    // Not tied to NODE_ENV: Coolify's proxy terminates TLS externally, but
    // doesn't reliably forward X-Forwarded-Proto to this container, so
    // Express can't detect the connection as secure even with trust proxy
    // enabled. The browser-to-proxy hop is always HTTPS in this deployment;
    // this only affects the internal proxy-to-container hop within Docker.
    secure: false,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

/** Creates the `session` table connect-pg-simple expects, if missing. */
export async function ensureSessionTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
}
