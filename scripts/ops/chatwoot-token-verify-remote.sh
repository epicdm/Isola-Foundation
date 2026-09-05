#!/usr/bin/env bash
# Runs ENTIRELY on host03 -- see chatwoot-token-verify.ps1, which scp's this
# file over and executes it with simple positional args. Kept as its own
# file (rather than inlined across an ssh hop) because a command built by
# nesting single/double quotes across PowerShell -> ssh -> remote-bash
# corrupts in transit -- measured 2026-09-05, see that script's header.
set -uo pipefail

STACK="${1:?stack name required}"
CW_BASE="${2:?chatwoot base url required}"
# Kept for CLI-contract stability (callers already pass inbox ids) even
# though Layer 2 below no longer keys off them directly -- see that layer's
# own note on why it checks reachability, not row counts, without a
# caller-supplied schema.
INBOX_IDS="${3:-}"

PASS=1
CID="$(sudo docker ps -q --filter label=com.docker.swarm.service.name=${STACK}_app | head -1)"
if [ -z "$CID" ]; then
  echo "REFUSED: no running container found for ${STACK}_app"
  exit 1
fi

echo "=== LAYER 1: boot log shows the token was read at container start ==="
BOOT_LINE="$(sudo docker service logs ${STACK}_app --since 24h 2>&1 | grep -i 'chatwoot_service_token' | tail -3)"
if [ -n "$BOOT_LINE" ]; then
  echo "  found boot-log evidence:"
  echo "$BOOT_LINE" | sed 's/^/    /'
else
  echo "  NO boot-log line found in the last 24h. Not fatal alone; layers 2/3 decide."
  PASS=0
fi

echo
echo "=== LAYER 2: the container's configured database is reachable from here, right now ==="
# Deliberately schema-agnostic: this proves DB reachability using the
# container's OWN connection env vars (a live TCP connect from inside the
# container, via Node's built-in net module -- no postgres client binary
# required, and no guess at table/column names this script has no verified
# right to assume). Measured 2026-09-05: this image ships neither `psql`
# nor a confirmed `pg` module, and has no single DATABASE_URL var -- the app
# builds its connection from DB_HOST/DB_NAME/DB_USER plus the db_password
# secret file. A hardcoded row-count query here would have been a guess
# dressed as a measurement -- exactly what Law 11 warns against. A caller
# who knows the schema can extend this layer with a real row-count query
# for their own binding table; this baseline never lies about what it
# actually checked, and reads no secret to do it (host+port only, never the
# password).
DB_CHECK="$(sudo docker exec "$CID" node -e '
  try {
    const host = process.env.DB_HOST;
    if (!host) { console.log("NO_DB_HOST"); process.exit(1); }
    const net = require("net");
    const s = net.createConnection(Number(process.env.DB_PORT) || 5432, host);
    s.setTimeout(5000);
    s.on("connect", () => { console.log("TCP_OK"); s.destroy(); process.exit(0); });
    s.on("timeout", () => { console.log("TCP_TIMEOUT"); process.exit(1); });
    s.on("error", (e) => { console.log("TCP_FAIL:" + e.code); process.exit(1); });
  } catch (e) { console.log("ERR:" + e.message); process.exit(1); }
' 2>&1)"
echo "  database reachability: ${DB_CHECK}"
case "$DB_CHECK" in
  TCP_OK) ;;
  *) echo "    database not reachable from the container -- treat the token's downstream effect as unverified"; PASS=0 ;;
esac

echo
echo "=== LAYER 3: live authenticated call to Chatwoot's own API, right now ==="
# Read the secret INSIDE the container's own mount namespace -- Swarm
# secrets are not visible on the host filesystem directly (measured
# 2026-09-05: a host-side `sudo cat /run/secrets/...` found nothing, while
# `docker exec ... cat /run/secrets/...` reads it fine).
TOK="$(sudo docker exec "$CID" cat /run/secrets/chatwoot_service_token 2>/dev/null)"
if [ -z "$TOK" ]; then
  API_RESULT="NO_SECRET_FILE"
else
  API_RESULT="$(curl -s -o /dev/null -w '%{http_code}' -H "api_access_token: ${TOK}" "${CW_BASE}/api/v1/profile")"
fi
echo "  GET ${CW_BASE}/api/v1/profile -> HTTP ${API_RESULT}"
if [ "$API_RESULT" = "200" ]; then
  echo "  LIVE -- token authenticates against Chatwoot right now."
else
  echo "  NOT LIVE (${API_RESULT}) -- the token the container is holding does not authenticate against ${CW_BASE} right now."
  PASS=0
fi

echo
if [ "$PASS" -eq 1 ]; then
  echo "RESULT: PASS -- all three layers agree the token resolved, was used, and is live."
  exit 0
else
  echo "RESULT: FAIL -- at least one layer did not confirm. Do not report the token as verified from a single layer alone."
  exit 1
fi
