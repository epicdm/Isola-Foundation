#!/bin/bash
# zz-acct2 PRODUCTION READ-ONLY (walk line ...5099). (1) read-only SQL on the plsvc prod DB for the account row, (2) run the read-only probe
# inside plsvc-prod-host03. Nothing here writes. Output is masked.
set -u
pq() { local cid=$(sudo -n docker ps -q -f name=$1 | head -1); local u=$(sudo -n docker exec $cid sh -c 'echo ${POSTGRES_USER:-postgres}' </dev/null); sudo -n docker exec -i $cid psql -U $u -d $2 -XAt -F' | ' </dev/null -c "$3"; }
m() { sed -E 's/([0-9]{5,})([0-9]{4})/***\2/g'; }
echo "== plsvc prod account row (read-only txn) =="
pq plsub_restore_db isolav2_prod "begin transaction read only; select id, right(did,4) as did4, \"sipUsername\", \"magnusUserId\", \"odooPartnerId\", \"registrationState\", to_char(\"createdAt\",'YYYY-MM-DD\"T\"HH24:MI') from lite_accounts where \"ownerPhone\"='14158408440'; select s.state, to_char(s.\"startedAt\",'YYYY-MM-DD\"T\"HH24:MI'), to_char(s.\"expiresAt\",'YYYY-MM-DD\"T\"HH24:MI'), p.code, p.\"magnusOfferId\" from lite_plan_subscriptions s join lite_plans p on p.id=s.\"planId\" join lite_accounts a on a.id=s.\"liteAccountId\" where a.\"ownerPhone\"='14158408440' order by s.\"startedAt\" desc; commit" | m
ACC=$(pq plsub_restore_db isolav2_prod "select \"odooPartnerId\" from lite_accounts where \"ownerPhone\"='14158408440' limit 1")
echo "odooPartnerId=$ACC (used for the Odoo read)"
C=$(sudo -n docker ps -q -f name=plsvc-prod-host03 | head -1)
NAME=$(sudo -n docker inspect $C --format '{{.Name}}')
case "$NAME" in /plsvc-prod-host03.*) echo "target ok: $NAME (PRODUCTION, READ-ONLY)";; *) echo "ABORT: target $NAME"; exit 1;; esac
sudo -n docker cp /home/epicadmin/zz-acct2-20261011/zz-acct2-prod-ro.mjs $C:/tmp/zz-acct2-prod-ro.mjs
sudo -n docker exec $C node /tmp/zz-acct2-prod-ro.mjs 14158408440 614 "$ACC" "${ZZ_MAGNUS_URL:-}" "${ZZ_ENGINE:-}" "${ZZ_FORCE_IP:-}" </dev/null
sudo -n docker exec $C rm -f /tmp/zz-acct2-prod-ro.mjs
