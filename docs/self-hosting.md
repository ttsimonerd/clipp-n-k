# Self-Hosting clipp'n'k

This document covers environment variables and configuration required to run clipp'n'k on your own infrastructure (Docker, Coolify, Fly.io, etc.).

## Required Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/dbname` |
| `SESSION_SECRET` | Random secret used to sign session cookies — generate with `openssl rand -hex 32` |
| `DISCORD_CLIENT_ID` | Client ID from your Discord OAuth2 application |
| `DISCORD_CLIENT_SECRET` | Client secret from your Discord OAuth2 application |

## GitHub Star Bonus (Optional)

The GitHub star bonus awards extra storage quota to users who star your GitHub repository. To enable it, register a **separate** GitHub OAuth App and set the following variables:

| Variable | Description |
|---|---|
| `GITHUB_CLIENT_ID` | Client ID from your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | Client secret from your GitHub OAuth App |
| `GITHUB_REDIRECT_URI` | Must match the **Authorization callback URL** set in your GitHub OAuth App (see below) |

### Setting the callback URL

When registering your GitHub OAuth App on github.com, set the **Authorization callback URL** to:

```
https://<your-domain>/api/auth/github/callback
```

Set `GITHUB_REDIRECT_URI` to the same value. For example:

```
GITHUB_REDIRECT_URI=https://clips.example.com/api/auth/github/callback
```

> **Tip:** The Admin Settings page (`/admin`) displays the exact callback URL for your running instance so you can copy-paste it directly into your GitHub OAuth App.

If `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, or `GITHUB_REDIRECT_URI` are not set, the GitHub star bonus feature is simply disabled — users can still log in via Discord normally.

## Discord OAuth Setup

Register an OAuth2 application at <https://discord.com/developers/applications> and add a redirect URI under **OAuth2 → Redirects**:

```
https://<your-domain>/api/auth/discord/callback
```

Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` to the values from your Discord application's **OAuth2** settings page.

> **Tip:** The Admin Settings page (`/admin`) displays the exact redirect URI for your running instance so you can copy-paste it directly into your Discord application.

## Upgrading

clipp'n'k uses migration files (tracked in the `__drizzle_migrations` table) to apply schema changes safely. Each migration runs exactly once, so you can upgrade without fear of data loss or destructive schema syncs.

To upgrade to a new release:

```bash
docker compose pull   # pull the new images (if using pre-built images)
docker compose build  # or rebuild from source
docker compose up -d  # the migrate service runs first, then the API starts
```

The `migrate` service is a one-shot container that applies any pending migration files before the API starts. If the migration fails, the API container will not start (it depends on `migrate` completing successfully), so a bad upgrade cannot silently serve requests against a partially-updated schema.

### Existing instances bootstrapped with `drizzle-kit push`

If you ran an earlier version that used `drizzle-kit push` to initialise the schema, no manual steps are needed. The initial migration file uses `CREATE TABLE IF NOT EXISTS` for every table and exception-guarded `ALTER TABLE` for foreign-key constraints, so running it against a database where those objects already exist is a no-op. The `migrate` service will apply the file, record it in `__drizzle_migrations`, and exit successfully. All future migrations will be tracked from that point forward.

## Notes

- All variables must be present at **startup**. Changing them requires a container restart.
- `GITHUB_REDIRECT_URI` in particular must stay consistent across re-deployments — if it drifts, GitHub OAuth callbacks will fail with a redirect-mismatch error.
