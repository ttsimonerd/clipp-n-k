# clipp'n'k

> The private clip-sharing hub for your squad — upload, trim, and share game highlights with your Discord server.

[!Deploy to Coolify](https://app.coolify.io/new?type=compose&repository=https://github.com/ttsimonerd/clipp-n-k-st)

---

## Features

- **Discord-only login** — access is gated to members of your Discord server
- **Upload & process clips** — trim, crop, and compress game footage automatically
- **Public / private clips** — toggle per clip; public clips get a shareable `/c/:slug` link with Discord embed support
- **Storage options** — local disk (zero config) or any S3-compatible bucket (AWS, MinIO, Cloudflare R2)
- **GitHub star bonus** — users can link GitHub and earn +1 GB storage for starring the repo
- **Admin panel** — configure branding, upload limits, storage quota, and allowed file types

## Self-hosting

One command on any machine with Docker:

```bash
cp .env.example .env   # fill in the required values
docker compose up --build -d
```

See **[SELF_HOSTING.md](SELF_HOSTING.md)** for the full guide, including step-by-step Coolify instructions.

## Stack

- **API:** Node.js 24, Express 5, Drizzle ORM, PostgreSQL
- **Frontend:** React, Vite, TanStack Query, shadcn/ui
- **Video:** fluent-ffmpeg (trim / crop / compress / thumbnail)
- **Auth:** Discord OAuth2 (manual, no third-party dependency)
- **Build:** esbuild (API), Vite (frontend), nginx (reverse proxy)

## Development

```bash
# Install dependencies
pnpm install

# Start the API server
pnpm --filter @workspace/api-server run dev

# Start the web frontend (separate terminal)
pnpm --filter @workspace/clippnk-web run dev

# Typecheck everything
pnpm run typecheck
```

Required env vars for local dev: `DATABASE_URL`, `SESSION_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `ADMIN_DISCORD_IDS`.

## License

MIT
