---
name: OpenAPI binary upload fields in Node-only packages
description: format: binary in an OpenAPI schema breaks type generation for Node-only (non-DOM-lib) generated client packages.
---

Declaring an upload field as `format: binary` in an OpenAPI spec causes generated TypeScript clients to reference DOM lib types (e.g. `Blob`/`File`) that don't exist in a Node-only package's `tsconfig` (no `"dom"` lib), producing TS errors like TS2308 in the generated code.

**Why:** hit this generating a typed API client for a Node-only `api-zod`/client package that also needs to work in non-browser contexts.

**How to apply:** for upload endpoints consumed by a Node-only generated client, declare the field as plain `string` in the OpenAPI schema instead of `format: binary`, and hand-roll the actual multipart upload call (e.g. raw `XMLHttpRequest`/`fetch` with `FormData`) in the frontend rather than relying on the generated method — this also gives you upload-progress events for free.
