#!/usr/bin/env bash
#
# Replit Run / Preview launcher for the Isola workspace.
#
# Starts the two processes the app needs and keeps them together:
#   1. artifacts/api-server  — the auth/session service. `artifacts/isola/lib/auth.ts`
#      calls http://localhost:8080/auth/user directly, so this port is fixed by
#      the application, not by preference.
#   2. artifacts/isola       — the Next.js app, bound to 0.0.0.0 on Replit's
#      supplied $PORT so the Replit proxy can route to it.
#
# Behaviour required of a Replit workflow:
#   - one routable public port (the web app)
#   - both processes stay alive
#   - logs preserved for both
#   - if either critical process dies, the whole workflow exits non-zero so
#     Replit reports the failure instead of serving a half-broken app
#   - children are shut down cleanly on exit/interrupt
#
# This script changes launch configuration only. It does not alter application
# behaviour, and it never seeds or migrates anything.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

API_PORT="${API_SERVER_PORT:-8080}"
WEB_PORT="${PORT:-5000}"
LOG_DIR="${ROOT}/.replit-preview-logs"
mkdir -p "$LOG_DIR"

api_pid=""
web_pid=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$web_pid" ] && kill "$web_pid" 2>/dev/null || true
  [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true
  # Give them a moment, then insist.
  sleep 1
  [ -n "$web_pid" ] && kill -9 "$web_pid" 2>/dev/null || true
  [ -n "$api_pid" ] && kill -9 "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[preview] root=$ROOT api_port=$API_PORT web_port=$WEB_PORT"

# The api-server is a build artifact; build it if this is a fresh workspace.
if [ ! -f "$ROOT/artifacts/api-server/dist/index.mjs" ]; then
  echo "[preview] building api-server"
  pnpm --filter @workspace/api-server run build
fi

echo "[preview] starting api-server on :$API_PORT"
PORT="$API_PORT" node --enable-source-maps "$ROOT/artifacts/api-server/dist/index.mjs" \
  > >(tee -a "$LOG_DIR/api-server.log") 2>&1 &
api_pid=$!

# Wait for the auth service before exposing the web app, so the first sign-in
# attempt cannot race a not-yet-listening dependency.
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:${API_PORT}/auth/user" 2>/dev/null; then
    echo "[preview] api-server ready"
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "[preview] FATAL: api-server exited during startup" >&2
    exit 1
  fi
  sleep 1
done

echo "[preview] starting web app on 0.0.0.0:$WEB_PORT"
cd "$ROOT/artifacts/isola"
npx next dev -H 0.0.0.0 -p "$WEB_PORT" \
  > >(tee -a "$LOG_DIR/web.log") 2>&1 &
web_pid=$!

echo "[preview] api_pid=$api_pid web_pid=$web_pid"

# Hold the workflow open; fail fast if either process dies.
while true; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "[preview] FATAL: api-server exited" >&2
    exit 1
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then
    echo "[preview] FATAL: web app exited" >&2
    exit 1
  fi
  sleep 3
done
