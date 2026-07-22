#!/usr/bin/env bash
# scripts/smoke-test-docker.sh
#
# Boots the full docker-compose stack with placeholder env vars and asserts
# that the key HTTP endpoints respond correctly. Tears down on exit.
#
# Usage:
#   bash scripts/smoke-test-docker.sh
#
# Optional overrides (env vars):
#   PORT              — host port to bind (default: 18080 to avoid conflicts)
#   SKIP_BUILD        — set to "1" to skip --build (use cached images)
#   KEEP_UP           — set to "1" to leave services running after tests

set -euo pipefail

HOST_PORT="${PORT:-18080}"
BASE="http://localhost:${HOST_PORT}"
PASS=0
FAIL=0

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN="\033[0;32m"
RED="\033[0;31m"
RESET="\033[0m"
ok()   { echo -e "${GREEN}✓ $*${RESET}"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}✗ $*${RESET}";  FAIL=$((FAIL + 1)); }

# ── Env vars (CI-safe placeholders) ──────────────────────────────────────────
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-smoke-test-postgres-pw}"
export SESSION_SECRET="${SESSION_SECRET:-smoke-test-session-secret-long-enough}"
export DISCORD_CLIENT_ID="${DISCORD_CLIENT_ID:-000000000000000000}"
export DISCORD_CLIENT_SECRET="${DISCORD_CLIENT_SECRET:-smoke-test-discord-secret}"
export DISCORD_REDIRECT_URI="${DISCORD_REDIRECT_URI:-http://localhost:${HOST_PORT}/api/auth/discord/callback}"
export ADMIN_DISCORD_IDS="${ADMIN_DISCORD_IDS:-000000000000000000}"
export PORT="${HOST_PORT}"

# ── Tear-down on exit ─────────────────────────────────────────────────────────
cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    echo ""
    echo "── Tearing down ─────────────────────────────────────────────────────"
    docker compose down --volumes 2>/dev/null || true
  else
    echo "KEEP_UP=1 — leaving services running on port ${HOST_PORT}"
  fi
}
trap cleanup EXIT

# ── Build & boot ─────────────────────────────────────────────────────────────
echo "── Starting docker compose stack on port ${HOST_PORT} ────────────────"
BUILD_FLAG="--build"
[ "${SKIP_BUILD:-0}" = "1" ] && BUILD_FLAG=""
docker compose up ${BUILD_FLAG} --detach

# ── Wait for /api/healthz ─────────────────────────────────────────────────────
echo ""
echo "── Waiting for ${BASE}/api/healthz ──────────────────────────────────"
MAX_WAIT=120
INTERVAL=3
ELAPSED=0

while true; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/healthz" 2>/dev/null || true)
  if [ "$STATUS" = "200" ]; then
    echo "  Ready after ${ELAPSED}s"
    break
  fi
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo ""
    echo "  Stack did not become healthy within ${MAX_WAIT}s. Compose logs:"
    docker compose logs --no-color --tail=60
    fail "Stack health timeout"
    exit 1
  fi
  echo "  ${ELAPSED}s — got '$STATUS', retrying in ${INTERVAL}s..."
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
done

# ── HTTP assertions ───────────────────────────────────────────────────────────
echo ""
echo "── Running smoke tests ───────────────────────────────────────────────"

check() {
  local label="$1"
  local expected="$2"
  local url="$3"

  actual=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)
  if [ "$actual" = "$expected" ]; then
    ok "${label} → ${actual}"
  else
    fail "${label} → expected ${expected}, got ${actual}"
  fi
}

check "GET /api/healthz"   "200" "${BASE}/api/healthz"
check "GET /"              "200" "${BASE}/"
check "GET /api/auth/me"   "401" "${BASE}/api/auth/me"   # 401 = API is up; 502 = it's not

# Healthz body must contain "ok"
BODY=$(curl -s "${BASE}/api/healthz" 2>/dev/null || true)
if echo "$BODY" | grep -q '"ok"'; then
  ok "GET /api/healthz body contains \"ok\""
else
  fail "GET /api/healthz body missing \"ok\" (got: $BODY)"
fi

# / must serve the SPA (html)
CONTENT_TYPE=$(curl -s -I "${BASE}/" 2>/dev/null | grep -i "^content-type:" | head -1 || true)
if echo "$CONTENT_TYPE" | grep -qi "text/html"; then
  ok "GET / Content-Type is text/html"
else
  fail "GET / Content-Type not text/html (got: $CONTENT_TYPE)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "── Results ───────────────────────────────────────────────────────────"
echo -e "  ${GREEN}Passed: ${PASS}${RESET}   ${RED}Failed: ${FAIL}${RESET}"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Compose logs (last 80 lines):"
  docker compose logs --no-color --tail=80
  exit 1
fi
