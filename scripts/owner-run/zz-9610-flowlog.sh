#!/bin/bash
# READ-ONLY: plsvc Flow/provision log lines since 07:19Z (pings excluded; phone digits masked), plus account/Magnus-relevant DB state.
PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
docker logs --since 2026-10-14T07:19:00Z $PL 2>&1 | grep -v 'action=ping' | sed -E 's/[0-9]{8,}/<n>/g' | cut -c1-210 | tail -25
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
echo "-- account:"; docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "select right(did,4), \"registrationState\", \"registeredAt\", \"installSelfReportedAt\", \"magnusUserId\", \"createdAt\" from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')" </dev/null
echo "-- attempts:"; docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "select to_char(created_at,'HH24:MI:SS'), * from lite_provision_attempts order by created_at desc limit 1" </dev/null | cut -c1-260
