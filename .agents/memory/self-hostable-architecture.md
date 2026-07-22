---
name: Self-hostable app architecture
description: Patterns for building apps that must run portably outside Replit (Docker/Coolify/self-host), avoiding Replit-specific conveniences that don't travel.
---

When a project's explicit requirement is Docker/Coolify/self-host portability:

- Implement OAuth manually (authorization-code flow) instead of using Replit's managed connector for that provider. Replit connectors are convenient but tie login to the Replit-hosted environment.
- Abstract storage behind an interface (e.g. `StorageDriver` with local-disk and S3 implementations, selected by an env var) instead of using Replit Object Storage, which is GCS-based and not portable to arbitrary self-host targets.
- Prefer direct-to-server uploads (e.g. multer to local disk) over presigned-cloud-upload flows when the server needs local file access afterward (e.g. for ffmpeg processing).

**Why:** these choices were made for a Discord-OAuth-gated clip-sharing app that had to run on Coolify/Docker/Vercel, not just Replit. Replit-specific integrations would have blocked that goal even though they'd have been faster to wire up.

**How to apply:** when a user states a self-host/portability requirement up front, default to the portable option even if a Replit integration exists for the same need — check with the user only if the tradeoff (setup time vs. portability) is unclear.
