---
name: Secret collection via AskQuestion
description: Never collect secret/credential values through a plain-text AskQuestion field.
---

Do not use a plain-text `AskQuestion` field to collect secret or credential values (API keys, tokens, passwords, client secrets) from the user, even when the value is needed for a legitimate integration setup. Use the environment-secrets flow (`requestSecrets`) directly as the collection mechanism instead.

**Why:** AskQuestion answers can end up logged/visible in ways that aren't appropriate for secrets; `requestSecrets` is the sanctioned, safe path for credential collection.

**How to apply:** any time a task requires a secret value from the user (Discord client secret, API key, etc.), reach for `requestSecrets` first — never draft an AskQuestion form with a text field for it.
