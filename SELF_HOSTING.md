# Self-Hosting clipp'n'k

clipp'n'k ships as a standard Docker Compose stack. Pick the guide that matches your setup:

- [**Coolify** (recommended for non-technical users)](#coolify)
- [**Generic Docker / VPS — pre-built images** (fastest)](#generic-docker--vps--pre-built-images)
- [**Generic Docker / VPS — build from source**](#generic-docker--vps--build-from-source)
- [**Environment variable reference**](#environment-variable-reference)

---

## Coolify

Coolify is the easiest way to self-host clipp'n'k — it handles HTTPS, domain routing, and
automatic deployments from GitHub with a web UI.

Two compose files are available for Coolify:

| File | How it works | When to use |
|------|-------------|-------------|
| `docker-compose.coolify.yaml` | Builds images from source on each deploy | You've modified the source code, or prefer not to pull third-party images |
| `docker-compose.coolify.prebuilt.yaml` | Pulls pre-built images from GHCR | Fastest option — ~30 s deploy, no build RAM required |

The steps below are the same for both files; just substitute the filename where noted.

### Prerequisites

- A running Coolify instance (self-hosted or [Coolify Cloud](https://coolify.io))
- A GitHub account and a fork (or clone) of this repo
- A Discord application with an OAuth2 redirect URI

### Step 1 — Import the repo into Coolify

**Coolify Cloud:** click the badge in the README — it pre-fills the repository URL for you.

**Self-hosted Coolify:** open your dashboard and paste this URL into your browser, replacing `<your-coolify>` with your instance domain:
```
https://<your-coolify>/new?type=compose&repository=https://github.com/ttsimonerd/clipp-n-k-st
```

Then in the resource wizard:
1. Choose **Docker Compose** as the resource type (auto-selected if you used the URL).
2. Confirm the source is the GitHub repo.
3. Set the **Docker Compose file** to one of:
   - `docker-compose.coolify.prebuilt.yaml` — **recommended**; pulls pre-built images, fastest
   - `docker-compose.coolify.yaml` — builds from source (needed if you've customised the code)
4. Click **Continue**.

### Step 2 — Assign a domain

1. In the resource settings, go to the **Network** tab.
2. Add your domain (e.g. `clips.example.com`). Coolify provisions a Let's Encrypt cert automatically.
3. Make sure port **80** is exposed (it is by default in `docker-compose.yml`).
4. Note the full domain — you'll need it in Step 3.

### Step 3 — Set environment variables

Go to the **Environment Variables** tab in Coolify and add the following.

> **Tip:** use the "Bulk edit" (raw text) mode to paste all variables at once.

```env
# ── Required ──────────────────────────────────────────────────────────────────

# Strong random password for the Postgres container
# Generate: openssl rand -hex 32
POSTGRES_PASSWORD=changeme

# Strong random secret for session cookies
# Generate: openssl rand -hex 64
SESSION_SECRET=changeme

# Discord OAuth — https://discord.com/developers/applications
# Add https://<your-coolify-domain>/api/auth/discord/callback as a redirect URI
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://clips.example.com/api/auth/discord/callback

# Comma-separated Discord user IDs with admin access
ADMIN_DISCORD_IDS=123456789012345678

# ── Optional — S3-compatible storage ──────────────────────────────────────────
# Leave blank to store clips on the Coolify volume (local disk, default).
# Set STORAGE_DRIVER=s3 to use AWS S3, MinIO, Cloudflare R2, etc.
STORAGE_DRIVER=local
S3_BUCKET=
S3_REGION=
S3_ENDPOINT=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=
S3_PUBLIC_BASE_URL=

# ── Optional — GitHub star bonus ───────────────────────────────────────────────
# Users can link GitHub and earn +1 GB storage for starring the repo.
# Leave blank to disable the feature entirely.
# Callback URL: https://<your-coolify-domain>/api/auth/github/callback
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=https://clips.example.com/api/auth/github/callback
```

Replace every `clips.example.com` with your actual Coolify domain.

### Step 4 — Configure Discord OAuth redirect URI

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and open your app.
2. Under **OAuth2 → General**, add the redirect URI:
   ```
   https://<your-coolify-domain>/api/auth/discord/callback
   ```
3. Save.

### Step 5 — Deploy

Click **Deploy** in Coolify. The build order is automatic:
`db` (healthy) → `migrate` (schema push) → `api` → `web`.

Once deployed, visit `https://<your-coolify-domain>` — you should see the login screen.

### Upgrading

1. Push or merge changes to your repo's default branch.
2. Coolify redeploys automatically (if auto-deploy is enabled) or click **Redeploy** manually.
3. The `migrate` service runs `drizzle-kit push` on every deploy — it only adds missing columns/tables, so upgrades are safe.

### Persistent volumes

Coolify mounts two Docker volumes automatically:

| Volume | Contents |
|--------|----------|
| `db-data` | PostgreSQL data directory |
| `clips-data` | Local clip files (empty when `STORAGE_DRIVER=s3`) |

Coolify preserves volumes across redeployments and Coolify instance upgrades.

---

## Generic Docker / VPS — pre-built images

> **Fastest option.** Uses images published to GitHub Container Registry on every release — no
> build toolchain required on your server. Cold-start time is ~30 s instead of ~5 min.

### Prerequisites

- A Linux server (Ubuntu 22.04+ recommended) with Docker and Docker Compose v2 installed
- A domain pointing at the server's IP (optional but recommended for HTTPS)
- Ports 80 (and 443 if doing TLS) open in your firewall

### Quick start

```bash
# 1. Clone the repo (only the compose file and .env are needed)
git clone https://github.com/ttsimonerd/clipp-n-k-st.git
cd clipp-n-k-st

# 2. Copy the env template and fill in required values
cp .env.example .env
$EDITOR .env

# 3. Pull and start all services (no build step)
docker compose -f docker-compose.prebuilt.yml up -d

# 4. Tail the logs to verify a clean start
docker compose -f docker-compose.prebuilt.yml logs -f
```

Open `http://localhost` (or your domain) — you should see the login screen.

### Pinning a specific release

By default, `docker-compose.prebuilt.yml` pulls the `latest` tag. To pin a specific version,
set `IMAGE_TAG` in your `.env` file:

```env
IMAGE_TAG=1.2.3
```

Find all available tags at
[ghcr.io/ttsimonerd/clipp-n-k-st](https://github.com/ttsimonerd/clipp-n-k-st/pkgs/container/clipp-n-k-st%2Fapi).

### Upgrading

```bash
# Pull the newest images, then recreate the containers
docker compose -f docker-compose.prebuilt.yml pull
docker compose -f docker-compose.prebuilt.yml up -d
```

The `migrate` service runs `drizzle-kit push` automatically on every start — it only adds
missing columns/tables, so upgrades are safe.

---

## Generic Docker / VPS — build from source

> Use this if you have modified the source code and want to run your own build, or if you prefer
> not to pull third-party images.

### Prerequisites

- A Linux server (Ubuntu 22.04+ recommended) with Docker and Docker Compose v2 installed
- At least **2 GB RAM** for the Node/esbuild build step
- A domain pointing at the server's IP (optional but recommended for HTTPS)
- Ports 80 (and 443 if doing TLS) open in your firewall

### Quick start

```bash
# 1. Clone the repo
git clone https://github.com/ttsimonerd/clipp-n-k-st.git
cd clipp-n-k-st

# 2. Copy the env template and fill in required values
cp .env.example .env
$EDITOR .env

# 3. Build images and start all services (~5 min on first run)
docker compose up --build -d

# 4. Tail the logs to verify a clean start
docker compose logs -f
```

Open `http://localhost` (or your domain) — you should see the login screen.

### Upgrading

```bash
git pull
docker compose up --build -d   # migrate re-runs automatically (idempotent)
```

### HTTPS with Caddy (recommended for both paths)

If you're not using Coolify or another reverse proxy, Caddy is the simplest way to add HTTPS:

```caddyfile
# Caddyfile
clips.example.com {
    reverse_proxy localhost:80
}
```

```bash
# Expose only 127.0.0.1:80 from docker-compose (set PORT=127.0.0.1:80 in .env)
# then start Caddy
caddy run --config Caddyfile
```

Caddy obtains and renews Let's Encrypt certs automatically.

---

## Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_PASSWORD` | ✅ | — | Password for the `clippnk` Postgres user |
| `SESSION_SECRET` | ✅ | — | Secret used to sign session cookies (`openssl rand -hex 64`) |
| `DISCORD_CLIENT_ID` | ✅ | — | Discord OAuth application client ID |
| `DISCORD_CLIENT_SECRET` | ✅ | — | Discord OAuth application client secret |
| `DISCORD_REDIRECT_URI` | ✅ | — | Full callback URL, e.g. `https://clips.example.com/api/auth/discord/callback` |
| `ADMIN_DISCORD_IDS` | ✅ | — | Comma-separated Discord user IDs with admin access |
| `IMAGE_TAG` | | `latest` | Image tag to pull (pre-built path only), e.g. `1.2.3` |
| `PORT` | | `80` | Host port that nginx binds to |
| `STORAGE_DRIVER` | | `local` | `local` (container volume) or `s3` |
| `STORAGE_LOCAL_DIR` | | `/app/data/clips` | Path inside the container for local storage |
| `S3_BUCKET` | | — | S3 bucket name (`STORAGE_DRIVER=s3` only) |
| `S3_REGION` | | — | S3 region (`STORAGE_DRIVER=s3` only) |
| `S3_ENDPOINT` | | — | Custom endpoint for MinIO / R2 (leave blank for AWS S3) |
| `S3_ACCESS_KEY_ID` | | — | S3 access key |
| `S3_SECRET_ACCESS_KEY` | | — | S3 secret key |
| `S3_FORCE_PATH_STYLE` | | — | Set `true` for MinIO path-style URLs |
| `S3_PUBLIC_BASE_URL` | | — | Public CDN base URL for direct media delivery |
| `GITHUB_CLIENT_ID` | | — | GitHub OAuth app client ID (star-bonus feature) |
| `GITHUB_CLIENT_SECRET` | | — | GitHub OAuth app client secret (star-bonus feature) |
| `GITHUB_REDIRECT_URI` | | — | GitHub callback URL, e.g. `https://clips.example.com/api/auth/github/callback` |

---

## Troubleshooting

**Server exits immediately with "missing required environment variable(s)"**
One or more required variables are blank or unset. The startup log lists every missing key, for example:

```
[clipp'n'k] Server cannot start — missing required environment variable(s):

  • SESSION_SECRET
  • DISCORD_CLIENT_ID

Set the above variable(s) in your .env file (see .env.example) and restart.
```

Open your `.env` (or the Coolify Environment Variables tab) and fill in every variable the message names. See the [Environment variable reference](#environment-variable-reference) table for descriptions and generation commands.

**Login redirects to `/?authError=oauth_failed`**
The Discord OAuth redirect URI in your Discord developer portal doesn't match `DISCORD_REDIRECT_URI`. Make sure both are identical, including the scheme (`https://`).

**Login redirects to `/?authError=not_member`**
The user is not a member of the Discord guild specified in the admin Settings page. Either invite them or clear the guild ID to allow any Discord user.

**`migrate` service fails on startup**
The `db` container isn't healthy yet. This is usually transient — Coolify / Docker will retry. If it persists, check `POSTGRES_PASSWORD` is set and consistent.

**Clips won't upload (413 error)**
The file exceeds the admin-configured max upload size. Raise it in the admin Settings page, or check that nginx's `client_max_body_size` in `nginx.conf` is large enough.

**Clips are lost after a redeployment**
Only happens if `STORAGE_DRIVER=local` and the `clips-data` volume was deleted. Use `STORAGE_DRIVER=s3` for durable storage, or ensure Coolify / Docker preserves the volume on redeploy.

**Pre-built image not found / 404 from GHCR**
Images are published on each `v*` git tag. If you're on an untagged commit (e.g. a fork's main branch), no image exists yet — use the build-from-source path or push a version tag first.
