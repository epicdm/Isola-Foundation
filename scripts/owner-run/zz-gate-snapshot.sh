#!/bin/bash
# READ-ONLY: spend gate + ledger counts (no deletes, no resets). Run as root on host04.
DB=$(docker ps -q -f name=uplink_uplink-db-prod | head -1)
docker exec $DB psql -U uplink -d uplink -X -At -F ' | ' -c "select 'gate', id, enabled, budget_micro_usd, spent_micro_usd, reserved_micro_usd, uncertain_micro_usd, to_char(starts_at,'MM-DD HH24:MI'), to_char(expires_at,'MM-DD HH24:MI') from public_turn_spend_gates" </dev/null
docker exec $DB psql -U uplink -d uplink -X -At -F ' | ' -c "select state, count(*), sum(reserved_micro_usd) from public_turn_spend_reservations group by state order by 1" </dev/null
