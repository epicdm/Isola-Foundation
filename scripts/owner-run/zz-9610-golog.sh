#!/bin/bash
# READ-ONLY: plsvc log lines since 07:30Z (pings excluded, digits masked) + account hand-off/registration columns.
PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
docker logs --since 2026-10-14T07:30:00Z $PL 2>&1 | grep -v 'action=ping' | sed -E 's/[0-9]{8,}/<n>/g; s#/go/[A-Za-z0-9_-]{8,}#/go/<nonce>#g' | cut -c1-230 | tail -25
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "select \"registrationState\", \"registrationHandoffAt\", \"registeredAt\", \"registrationCheckedAt\" from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')" </dev/null
echo "-- activation tables: "; docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "select table_name from information_schema.columns where column_name in ('nonce','activationNonce') and table_schema='public'" </dev/null | tr '\n' ' '
