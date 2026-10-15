#!/bin/bash
# READ-ONLY part 3: Uplink conversation bfb21e28* (status, counts, no content), plus the lite_minute_ledger rows and Magnus credit facts via the existing read script.
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); UD=$(docker ps -q -f name=uplink_uplink-db-prod | head -1)
q()  { docker exec -i $C  psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qu() { docker exec -i $UD psql -U uplink  -d uplink       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
AID=$(q "select id from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610') limit 1")
echo "### Uplink conversation(s) matching bfb21e28 (control: total conversations)"
qu "select count(*) from agent_conversations"
qu "select id, status, turn_count, to_char(started_at,'MM-DD HH24:MI'), to_char(last_turn_at,'MM-DD HH24:MI'), ended_at is not null from agent_conversations where id::text like 'bfb21e28%'"
echo "### lite_minute_ledger rows for the account (type, minutes, destination, createdAt)"
q "select type, minutes, destination, to_char(\"createdAt\",'MM-DD HH24:MI') from lite_minute_ledger where \"liteAccountId\"='$AID' order by \"createdAt\""
echo "### activation rows: tables mentioning activation"
q "select table_name from information_schema.tables where table_schema='public' and table_name ilike '%activation%' order by 1" | tr '\n' ' '; echo
