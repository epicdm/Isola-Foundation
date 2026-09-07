#!/usr/bin/env bash
###############################################################################
# FIRE the `unavailable` state. Do not assert it.
#
# HARNESS NOTE (first attempt was inconclusive, and it was the harness's
# fault, not the product's):
#   - sid.mjs had been `docker cp`'d into the app container, so a service
#     update -- which RECREATES the task -- destroyed it. The lookup returned
#     empty, every request carried an empty cookie, and everything 401'd.
#     The session lookup now runs in the DB container, which survives.
#   - the state was scraped with an unanchored sed that matched a DOCUMENT's
#     "state":"posted" instead of the top-level envelope state.
###############################################################################
set -uo pipefail

SVC="isola360uat_app"
GOOD_URL="https://epic-communications-inc.odoo.com"
# TEST-NET-1 (RFC5737): guaranteed unroutable. This is a TRANSPORT failure,
# which is a different code path from bad credentials.
BAD_URL="https://192.0.2.1"

get_sid() {
  local dbc; dbc=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=isola360uat_db | head -1)
  sudo docker exec "$dbc" sh -c '
    PGPASSWORD=$(cat /run/secrets/db_password) psql -U isola360 -d isola360uat -tAc \
      "SELECT sid FROM sessions WHERE sess->'"'"'user'"'"'->>'"'"'id'"'"' = '"'"'uat-operator-a'"'"' LIMIT 1"
  ' 2>/dev/null | tr -d '[:space:]'
}

wait_serving() {
  for i in $(seq 1 40); do
    local cid; cid=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=$SVC | head -1)
    local code=""
    [ -n "$cid" ] && code=$(sudo docker exec "$cid" curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null)
    [ "${code:-}" = "200" ] && { echo "  serving after ${i} check(s)"; return 0; }
    sleep 5
  done
  echo "  DID NOT CONVERGE"; return 1
}

fire() { # sid label
  local sid="$1" label="$2"
  if [ -z "$sid" ]; then
    printf "  %-24s SKIPPED - no session id (harness fault, not a result)\n" "$label"
    return
  fi
  local code; code=$(curl -s -o /tmp/u.json -w '%{http_code}' --max-time 90 \
    -X POST https://isola-360-uat.saas00.epic.dm/api/isola-360/context \
    -H 'Content-Type: application/json' -H "Cookie: sid=${sid}" \
    -d '{"hint":{"accountIdHint":3,"inboxIdHint":4,"conversationDisplayIdHint":90001}}')
  # ANCHORED to the start of the envelope. Project fields; never dump the body,
  # which carries a real customer's name, email and phone.
  local state; state=$(grep -o '^{"state":"[a-z-]*"' /tmp/u.json | sed 's/.*"state":"//;s/"//')
  local msg;   msg=$(grep -o '"message":"[^"]*"' /tmp/u.json | head -1 | sed 's/"message":"//;s/"$//')
  printf "  %-24s http=%-4s state=%-12s %s\n" "$label" "$code" "${state:--}" "${msg:-}"
}

echo "=== REVERSAL, written before the mutation ==="
echo "  sudo docker service update --env-add ODOO_URL=${GOOD_URL} ${SVC}"
echo

SID=$(get_sid)
echo "=== CONTROL: the harness can read a session at all (length=${#SID}) ==="
[ -z "$SID" ] && { echo "  ABORT: no session id; fix the harness before drawing conclusions"; exit 1; }

echo
echo "=== BEFORE: Odoo reachable (positive control) ==="
fire "$SID" "odoo reachable"

echo
echo "=== breaking Odoo TRANSPORT (unroutable address) ==="
sudo docker service update --quiet --env-add "ODOO_URL=${BAD_URL}" "$SVC" >/dev/null 2>&1
wait_serving
SID=$(get_sid)   # same row, but re-read after recreation
echo
echo "=== THE PROOF: identical request, Odoo unreachable ==="
fire "$SID" "odoo UNREACHABLE"
echo "  expected: state=unavailable. FORBIDDEN: state=ready with empty balances,"
echo "  which would tell an operator the customer owes nothing."

echo
echo "=== restoring ==="
sudo docker service update --quiet --env-add "ODOO_URL=${GOOD_URL}" "$SVC" >/dev/null 2>&1
wait_serving
SID=$(get_sid)
echo
echo "=== AFTER: restored (proves the break caused it, not coincidence) ==="
fire "$SID" "odoo reachable again"

echo
echo "=== env read-back ==="
sudo docker service inspect "$SVC" \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
  | grep '^ODOO_URL=' | sed 's/^/  /'
