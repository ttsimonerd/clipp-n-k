---
name: installLanguagePackages workspace limitation
description: The installLanguagePackages callback can fail for artifact-scoped dependencies in this pnpm monorepo template.
---

In this pnpm-workspace-based project template, the `installLanguagePackages` callback can fail (or install into the wrong scope) when adding a dependency that should belong to a specific artifact package (e.g. `artifacts/api-server`) rather than the workspace root.

**Why:** observed while adding server-side dependencies (e.g. ffmpeg wrapper, S3 client, session-store packages) to an artifact during MVP build-out.

**How to apply:** when a dependency needs to live in a specific workspace package, prefer running `pnpm add <package> --filter @workspace/<artifact-name>` directly via the shell instead of relying on `installLanguagePackages` for artifact-scoped installs.
