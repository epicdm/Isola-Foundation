#!/bin/bash
# BACKUP before the owner-authorized reset of 9610 (17672859610). Writes to /var/backups/pl-9610-reset-20261014/ (root, 0700). READ-ONLY on every live system. Needs /tmp/zz-9610-magnus-dump.js staged.
B=/var/backups/pl-9610-reset-20261014; mkdir -p $B; chmod 700 $B
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1); P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
AID=$(docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "select id from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610') limit 1" </dev/null)
echo "account id: $AID"
cp -p /home/epicadmin/plprod/runtime-flags.json $B/runtime-flags.json.before; echo "flags before sha: $(sha256sum $B/runtime-flags.json.before | cut -c1-64)"
cp_(){ docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "\\copy ($2) to stdout with csv header" </dev/null > $B/$1.csv; echo "  $1: $(($(wc -l < $B/$1.csv)-1)) rows"; }
cp_ lite_accounts "select * from lite_accounts where id='$AID'"
cp_ lite_plan_subscriptions "select * from lite_plan_subscriptions where \"liteAccountId\"='$AID'"
cp_ lite_minute_ledger "select * from lite_minute_ledger where \"liteAccountId\"='$AID'"
cp_ lite_provision_attempts "select * from lite_provision_attempts where user_id=(select \"userId\" from lite_accounts where id='$AID')"
cp_ whatsapp_opt_in "select * from whatsapp_opt_in where \"userId\"=(select \"userId\" from lite_accounts where id='$AID') or phone like '%7672859610%'"
cp_ lite_admission_log "select * from lite_admission_log where sender_phone like '%7672859610%'"
cp_ lite_admission_queue "select * from lite_admission_queue where sender_phone like '%7672859610%'"
docker exec -i $CW psql -U postgres -d isola -X -At -c "\\copy (select id, inbox_id, status, assignee_id, contact_id, created_at, last_activity_at from conversations where id=599) to stdout with csv header" </dev/null > $B/chatwoot_conv_599.csv; echo "  chatwoot_conv_599: $(($(wc -l < $B/chatwoot_conv_599.csv)-1)) rows (status/assignee only; custom_attributes not copied)"
docker exec -i -w /app $P node - < /tmp/zz-9610-magnus-dump.js 2>&1 | tail -2
docker cp $P:/tmp/9610-magnus-before.json $B/magnus-before.json >/dev/null && chmod 600 $B/magnus-before.json
docker exec $P rm -f /tmp/9610-magnus-before.json </dev/null
chmod 600 $B/*; ls -l $B | awk '{print $5, $9}'
