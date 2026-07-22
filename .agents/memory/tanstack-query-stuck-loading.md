---
name: TanStack Query stuck-loading pitfalls
description: Two distinct ways a TanStack Query-driven "isLoading" gate can appear stuck on a spinner well after the query should have settled.
---

Two separate issues can make a component stuck showing a loading spinner (gated on `isLoading`) long after a query should have settled to `error`/`success`:

1. **`networkMode: 'online'` (the default) + `navigator.onLine` false**: the query's `fetchStatus` goes to `"paused"` instead of failing, so `isLoading` never flips to false. This can happen for real users behind flaky proxies/VPNs that misreport online status, and reliably happens in some headless/automated browser tools used for screenshot-based verification (they can report `navigator.onLine: false`). Fix: set `networkMode: 'always'` in the QueryClient defaults (queries and mutations) unless you specifically want offline-pausing behavior.
2. **Default retry + exponential backoff on non-transient errors**: with `retry: 1` (or higher), a 401/403/other 4xx response gets retried anyway, adding a real delay (e.g. ~1s+) before the query settles to `error` — during that window `isLoading` is still true. This is wasted latency since 4xx errors aren't transient. Fix: use a `retry` function that returns `false` for 4xx `ApiError` responses (checking `error.status`) and only retries on network/5xx errors.

**Why:** a login-gated app appeared permanently stuck on a spinner during automated verification; both causes had to be fixed together — networkMode alone didn't fully resolve the delay because the retry-driven settle time was still longer than the screenshot tool's capture window.

**How to apply:** when any `useQuery`-gated loading state seems to never resolve (especially auth "who am I" checks), check both networkMode and retry-on-4xx behavior before assuming the bug is elsewhere (e.g. before adding debug logging to the render path).
