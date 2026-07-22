/**
 * Startup environment-variable validation.
 *
 * Call `validateEnv()` once before the server starts accepting requests.
 * Any missing required variable causes an immediate, descriptive exit so
 * self-hosters see exactly what to fix instead of a cryptic runtime error.
 */

const ALWAYS_REQUIRED = [
  "SESSION_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "ADMIN_DISCORD_IDS",
] as const;

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of ALWAYS_REQUIRED) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  // S3 vars are only required when STORAGE_DRIVER=s3
  if (process.env["STORAGE_DRIVER"] === "s3") {
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
  }

  if (missing.length === 0) return;

  const list = missing.map((k) => `  • ${k}`).join("\n");
  console.error(
    `\n[clipp'n'k] Server cannot start — missing required environment variable(s):\n\n${list}\n\n` +
      `Set the above variable(s) in your .env file (see .env.example) and restart.\n`,
  );
  process.exit(1);
}

// Run validation immediately when this module is first imported so that it
// executes before any other module's top-level code reads environment variables.
validateEnv();
