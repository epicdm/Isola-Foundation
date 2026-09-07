#!/usr/bin/env bash
###############################################################################
# Two processes, one container, and they live or die together.
###############################################################################
set -euo pipefail
cd /repo

log() { echo "[entrypoint] $*"; }

# Compose DATABASE_URL from the mounted secret rather than accepting it
# pre-interpolated. A URL carrying the password in the service spec is
# readable by anyone who can run `docker service inspect`.
if [ -z "${DATABASE_URL:-}" ] && [ -f /run/secrets/db_password ]; then
  DATABASE_URL="postgresql://${DB_USER:-isola360}:$(cat /run/secrets/db_password)@${DB_HOST:-db}:5432/${DB_NAME:-isola360uat}"
  export DATABASE_URL
  log "composed DATABASE_URL from the mounted db_password secret (value not logged)"
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

# Wait for postgres rather than racing it. Swarm starts services in parallel,
# so the first `migrate deploy` would otherwise fail on a cold database and
# take the container down with it.
for i in $(seq 1 60); do
  # Dependency-free: pnpm's node_modules layout is symlinked and there is no
  # guarantee `pg` resolves from /repo. node's own net module always does.
  if node -e "
    const s=require('net').connect(5432, process.env.DB_HOST || 'db');
    s.setTimeout(3000);
    s.on('connect', () => { s.end(); process.exit(0); });
    s.on('error', () => process.exit(1));
    s.on('timeout', () => process.exit(1));
  " 2>/dev/null; then
    log "database reachable after ${i} attempt(s)"
    break
  fi
  [ "$i" = "60" ] && { log "database never became reachable"; exit 1; }
  sleep 2
done

# Mediated secret: the Odoo key arrives as a swarm secret FILE, never as a
# value in the service spec, so `docker service inspect` cannot disclose it.
# This is the same shape the mediated-secret work already proved for Paperclip.
# The Customer 360 service token, by the same route as the odoo key: mounted as
# a swarm secret and exported here, so the VALUE never appears in stack.yml and
# is never disclosed by `docker service inspect`. Only its length is logged.
if [ -f /run/secrets/isola_360_service_token ]; then
  ISOLA_360_SERVICE_TOKEN="$(cat /run/secrets/isola_360_service_token)"
  export ISOLA_360_SERVICE_TOKEN
  log "isola-360 service token loaded from swarm secret (length ${#ISOLA_360_SERVICE_TOKEN}, value not logged)"
else
  log "isola-360 service token NOT present -- the server-to-server surface will refuse every caller (fail closed)"
fi

if [ -f /run/secrets/odoo_api_key ]; then
  ODOO_API_KEY="$(cat /run/secrets/odoo_api_key)"
  export ODOO_API_KEY
  log "odoo api key loaded from swarm secret (length ${#ODOO_API_KEY}, value not logged)"
else
  log "WARNING: no odoo api key secret mounted; Odoo reads will fail closed"
fi

# EPIC's own Chatwoot mirror bindings (inboxes 7/8/12, see
# lib/epic-owner-chatwoot-seed-data.ts) resolve their token via
# env:CHATWOOT_SERVICE_TOKEN at use time (lib/engines.ts's
# resolveChatwootToken). Same mounted-secret shape as the two above: the
# value never appears in stack.yml and is never disclosed by
# `docker service inspect`. Missing this is non-fatal to boot -- the mirror
# call degrades per-turn (lib/agent.ts catches ChatwootCredentialRefError)
# rather than crashing the server -- but the mirror sends nothing until it
# is mounted.
if [ -f /run/secrets/chatwoot_service_token ]; then
  CHATWOOT_SERVICE_TOKEN="$(cat /run/secrets/chatwoot_service_token)"
  export CHATWOOT_SERVICE_TOKEN
  log "chatwoot service token loaded from swarm secret (length ${#CHATWOOT_SERVICE_TOKEN}, value not logged)"
else
  log "WARNING: no chatwoot service token secret mounted; EPIC mirror bindings will fail closed (ChatwootCredentialRefError, non-fatal per lib/agent.ts)"
fi

log "applying prisma migrations (migrate deploy -- never db push)"
pnpm --filter @workspace/isola exec prisma migrate deploy

# The api-server THROWS if PORT is unset, and Next also reads PORT. They are
# given their ports separately: PORT scoped to the api-server process only,
# and an explicit -p for Next.
log "starting express api-server on :8080"
PORT=8080 node artifacts/api-server/dist/index.mjs &
API=$!

log "starting next on :3000"
pnpm --filter @workspace/isola exec next start -p 3000 -H 0.0.0.0 &
WEB=$!

# If EITHER process dies, the container must die too. A half-dead container
# still answering on :3000 would serve a UI whose auth backend is gone --
# fluent failure, which is the dangerous kind.
wait -n
code=$?
log "a child process exited (status ${code}); stopping the other and exiting non-zero"
kill "$API" "$WEB" 2>/dev/null || true
exit 1
