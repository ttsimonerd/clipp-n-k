---
name: connect-pg-simple + esbuild bundling
description: Why connect-pg-simple's createTableIfMissing breaks in an esbuild single-file bundle, and how to fix it.
---

`connect-pg-simple`'s `createTableIfMissing: true` option reads a `table.sql` template file using a path relative to its own installed package directory at runtime. When the consuming server is bundled by esbuild into a single output file (e.g. `dist/index.mjs`), that relative path no longer resolves — the package directory isn't there anymore — causing an `ENOENT` at startup. The session table silently never gets created, so login sessions don't persist in production even though everything looks fine in dev (unbundled).

**Why:** discovered while debugging a self-hosted Express + Postgres session setup; the bug only manifests after bundling, not in `tsx`/dev-mode runs, so it's easy to miss until production.

**How to apply:** set `createTableIfMissing: false` and instead create the session table yourself via a raw, idempotent `CREATE TABLE IF NOT EXISTS "session" (...)` + index SQL statement, run once at server startup before `app.listen`. Apply this any time a server using `connect-pg-simple` is bundled into a single file for deployment/self-host.
