# clipp'n'k

A self-hosted clip-sharing hub for gamers: log in with Discord, upload game clips, trim/crop/compress them, and share a link that unfurls nicely in Discord.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/clippnk-web run dev` — run the web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `SESSION_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `ADMIN_DISCORD_IDS`
- Optional storage env (self-host): `STORAGE_DRIVER` (`local` default | `s3`), `STORAGE_LOCAL_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`

## Self-hosting with Docker

One-command boot on any machine with Docker installed:

```bash
# 1. Copy the env template and fill in the required values
cp .env.example .env
$EDITOR .env          # set POSTGRES_PASSWORD, SESSION_SECRET, DISCORD_*, ADMIN_DISCORD_IDS

# 2. Start everything (DB → migrate → api → web)
docker compose up --build -d

# 3. Open http://localhost (or the PORT you set in .env)
```

**What runs:**
| Service  | Image             | Role                                                      |
|----------|-------------------|-----------------------------------------------------------|
| `db`     | postgres:17-alpine | Postgres data store                                       |
| `migrate`| (builder stage)   | Runs `drizzle-kit push` to create/update tables, then exits |
| `api`    | Dockerfile.api    | Express API + ffmpeg video processing (port 3001 internal) |
| `web`    | Dockerfile.web    | nginx: serves the Vite SPA + proxies `/api` and `/c` to api |

**Key files:**
- `docker-compose.yml` — full service wiring with Postgres, volumes, and health-checks
- `Dockerfile.api` — multi-stage: build (esbuild bundle) → runtime (node:24-alpine + ffmpeg)
- `Dockerfile.web` — multi-stage: build (Vite) → runtime (nginx)
- `nginx.conf` — proxies `/api/*` and `/c/*` to the api container; SPA fallback for everything else
- `.env.example` — all env vars documented with generation commands

**Upgrading:**
```bash
git pull
docker compose up --build -d   # migrate re-runs automatically (idempotent)
```

**Volumes:**
- `db-data` — Postgres data directory
- `clips-data` — local clip storage (unused when `STORAGE_DRIVER=s3`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, `express-session` + `connect-pg-simple` (Postgres-backed sessions)
- DB: PostgreSQL + Drizzle ORM
- Video processing: `fluent-ffmpeg` (trim/crop/compress + thumbnail extraction)
- Frontend: React + Vite, wouter, TanStack Query, shadcn/ui
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (api-server bundles to a single `dist/index.mjs`)

## Where things live

- `artifacts/api-server/src/lib/discord.ts` — manual Discord OAuth2 flow (authorize URL, code exchange, user/guild lookups). Not using Replit's Discord connector, for Docker/self-host portability.
- `artifacts/api-server/src/lib/storage/` — storage driver abstraction (`local-disk.ts` default, `s3.ts` for S3-compatible endpoints), selected at runtime via `STORAGE_DRIVER`.
- `artifacts/api-server/src/lib/ffmpeg.ts` — probing, trim/crop/compress, thumbnail extraction.
- `artifacts/api-server/src/lib/session.ts` — session middleware + `ensureSessionTable()` (see Gotchas).
- `artifacts/api-server/src/routes/share.ts` — server-rendered `/c/:slug` HTML page with per-request Open Graph tags, mounted outside `/api` (see `artifact.toml` `paths = ["/api", "/c"]`).
- `artifacts/api-server/src/middlewares/auth.ts` — `requireAuth`/`requireAdmin`; admin identity comes from `ADMIN_DISCORD_IDS` env var, not the DB.
- `lib/db/src/schema/` — `users`, `clips`, `site-settings` (singleton row, id=1) tables.
- `lib/api-spec/openapi.yaml` — source of truth for the API contract; regenerate hooks/schemas after edits.
- `artifacts/clippnk-web/` — frontend (dashboard, clip view/editor, admin settings, login/blocked screens).

## Architecture decisions

- Discord OAuth is implemented directly (no Replit connector) so the app can self-host on Coolify/Docker/Vercel without depending on Replit-only infra. Guild membership is checked via `GET /users/@me/guilds` with the user's own OAuth token — no bot token needed.
- Storage is behind a driver interface rather than Replit Object Storage, because Replit's Object Storage is GCS-based and not portable to a self-hosted Docker deployment. Local disk is the zero-config default; S3-compatible (MinIO/R2/AWS) is a drop-in swap via env vars.
- Per-user storage quota is computed dynamically from the admin-editable `site_settings.maxUserStorageBytes` at request time rather than stored per-user, so admin changes to the global quota apply immediately without a migration.
- The GitHub-star bonus storage feature (+1GB for starring the repo) is a separate, later task — do not add per-user bonus columns/logic for it here.

## Product

- Discord-only login, gated to members of one configurable Discord server (admin sets the guild ID in Settings).
- Upload a game clip (up to the admin-configured size), trim/crop it, and it's automatically compressed with a thumbnail generated.
- Toggle a clip public/private; public clips get a shareable `/c/:slug` link with Discord-embeddable video previews.
- Admin settings page (gated to `ADMIN_DISCORD_IDS`) controls branding, upload limits, per-user storage quota, allowed file types, and default visibility.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `connect-pg-simple`'s `createTableIfMissing: true` reads a `table.sql` template via a path relative to its own package directory. That breaks once the server is esbuild-bundled into a single `dist/index.mjs` (the template isn't copied alongside it) — it throws `ENOENT` at startup. Fixed by setting `createTableIfMissing: false` and creating the `session` table ourselves via raw SQL in `ensureSessionTable()`, called once at boot in `src/index.ts`.
- After any change to `lib/db/src/schema/`, run `pnpm -w run typecheck:libs` (or `tsc --build`) before typechecking `api-server` — its TS project reference won't pick up schema changes otherwise.
- OpenAPI file-upload fields must use `type: string` (not `format: binary`) in `lib/api-spec/openapi.yaml`; `format: binary` generates `Blob`/`File` types that fail typecheck in the Node-only (no DOM lib) `@workspace/api-zod` package. The upload endpoint is hand-rolled via raw `fetch`/`XHR` on the frontend for progress tracking, not the generated hook.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
