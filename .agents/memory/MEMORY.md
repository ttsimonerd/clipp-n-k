# Memory Index

- [Self-hostable app architecture](self-hostable-architecture.md) — avoid platform-specific connectors/object storage when Docker self-host portability is required; use manual OAuth + a storage-driver interface instead.
- [connect-pg-simple + esbuild bundling](connect-pg-simple-esbuild.md) — `createTableIfMissing` breaks once esbuild bundles the server into a single file; create the session table via raw SQL instead.
- [OpenAPI binary upload fields in Node-only packages](openapi-binary-upload-fields.md) — `format: binary` triggers DOM-lib TS errors in Node-only generated clients; use plain `string` and hand-roll the upload request.
- [TanStack Query stuck-loading pitfalls](tanstack-query-stuck-loading.md) — default retry backoff and `networkMode: 'online'` can both leave a UI stuck on a loading spinner after an auth 401; don't retry 4xx and consider `networkMode: 'always'`.
- [Secret collection via AskQuestion](secret-collection.md) — never collect secret/credential values through a plain-text AskQuestion field; use `requestSecrets` directly.
- [installLanguagePackages workspace limitation](install-language-packages-workspace.md) — the callback fails for artifact-scoped deps in this pnpm workspace; use `pnpm add --filter <package>` via shell instead.
