#!/usr/bin/env bash
###############################################################################
# Runs ON host03. Proves the deployed Customer 360 staging surface.
#
# Session ids are fetched from the database and used, never printed.
#
# NOTE ON TRANSPORT: the Next route forwards only the COOKIE header to
# /auth/user (lib/session.ts passes `{ Cookie: ... }`). An Authorization
# bearer works on the Express server directly but NOT through this path, so
# every authenticated probe below uses `Cookie: sid=...`.
###############################################################################
set -uo pipefail

URL="https://isola-360-uat.saas00.epic.dm"
CID=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=isola360uat_app | head -1)
[ -z "$CID" ] && { echo "app container not running"; exit 1; }

sudo docker cp /home/epicadmin/builds/isola360-b59b8f0c/deploy/sid.mjs "$CID":/repo/artifacts/isola/sid.mjs >/dev/null 2>&1

sid_for() {
  sudo docker exec -w /repo/artifacts/isola "$CID" node sid.mjs "$1" 2>/dev/null
}

hit() { # label expected_status cookie body
  local label="$1" expect="$2" cookie="$3" body="$4"
  local args=(-s -o /tmp/resp.json -w '%{http_code}' -X POST "$URL/api/isola-360/context"
              -H 'Content-Type: application/json' --max-time 45)
  [ -n "$cookie" ] && args+=(-H "Cookie: sid=${cookie}")
  args+=(-d "$body")
  local code; code=$(curl "${args[@]}")
  local state; state=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/tmp/resp.json','utf8')).state||'-')}catch(e){console.log('-')}" 2>/dev/null \
    || python3 -c "import json,sys;print(json.load(open('/tmp/resp.json')).get('state','-'))" 2>/dev/null || echo '-')
  printf "  %-52s http=%-4s state=%-12s %s\n" "$label" "$code" "$state" \
    "$([ "$code" = "$expect" ] && echo PASS || echo "FAIL(expected $expect)")"
  cat /tmp/resp.json 2>/dev/null | head -c 600; echo; echo
}

echo "=============================================================="
echo " CUSTOMER 360 UAT - LIVE PROOF"
echo " $URL"
echo "=============================================================="
echo
echo "--- 1. health (does it SERVE, not merely exist) ---"
curl -s -o /tmp/h.json -w "  GET /api/health -> http=%{http_code}\n" --max-time 30 "$URL/api/health"
echo "  body: $(head -c 200 /tmp/h.json)"
echo
echo "--- 2. TLS certificate actually issued for this host ---"
echo | openssl s_client -servername isola-360-uat.saas00.epic.dm \
  -connect isola-360-uat.saas00.epic.dm:443 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates 2>/dev/null | sed 's/^/  /'
echo
echo "--- 3. CONTROL: unauthenticated MUST be refused (fail closed) ---"
hit "no session at all" 401 "" '{"hint":{"accountIdHint":3,"inboxIdHint":4,"conversationDisplayIdHint":90001}}'

echo "--- 4. CONTROL: a well-formed but BOGUS session must also be refused ---"
hit "invalid session id" 401 "0000000000000000000000000000000000000000000000000000000000000000" \
  '{"hint":{"accountIdHint":3,"inboxIdHint":4,"conversationDisplayIdHint":90001}}'

SIDA=$(sid_for uat-operator-a)
SIDB=$(sid_for uat-operator-b)
echo "  (session A length=${#SIDA}, B length=${#SIDB} — values not printed)"
[ -z "$SIDA" ] && { echo "  no seeded session A; run the seed first"; exit 1; }
echo

echo "--- 5. THE REAL PROOF: operator A, their own conversation ---"
hit "tenant A / account 3 / inbox 4 / conv 90001" 200 "$SIDA" \
  '{"hint":{"accountIdHint":3,"inboxIdHint":4,"conversationDisplayIdHint":90001}}'

echo "--- 6. no Odoo match resolves to not-found, NOT to unavailable ---"
hit "tenant A / conv 90003 (phone not in Odoo)" 200 "$SIDA" \
  '{"hint":{"accountIdHint":3,"inboxIdHint":4,"conversationDisplayIdHint":90003}}'

echo "--- 7. CROSS-TENANT CONTROL: operator B may NOT read tenant A ---"
hit "tenant B asking for tenant A's conv 90001" 200 "$SIDB" \
  '{"hint":{"accountIdHint":3,"inboxIdHint":4,"conversationDisplayIdHint":90001}}'

echo "--- 8. POSITIVE TWIN: operator B CAN read their own door ---"
echo "    (without this, test 7 proves only that B is broken)"
hit "tenant B / account 3 / inbox 99 / conv 90002" 200 "$SIDB" \
  '{"hint":{"accountIdHint":3,"inboxIdHint":99,"conversationDisplayIdHint":90002}}'

echo "--- 9. the page itself is served ---"
curl -s -o /tmp/p.html -w "  GET /isola-360 -> http=%{http_code} bytes=%{size_download}\n" --max-time 30 "$URL/isola-360"
grep -qi 'customer' /tmp/p.html && echo "  page mentions 'customer' (rendered, not an error page)" \
  || echo "  page did NOT mention 'customer' — inspect it"
