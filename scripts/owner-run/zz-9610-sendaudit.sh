#!/bin/bash
# READ-ONLY: the suppressed send at ~07:31 for 9610 (purpose/decision/senderPath/sourceEvent, meta keys only) and the opt-in rows state.
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
q "select to_char(\"createdAt\",'HH24:MI:SS'), purpose, decision, \"dispatchStatus\", \"senderPath\", \"sourceEventType\", \"windowValid\", \"optInId\" is not null as has_optin, coalesce(\"errorSummary\",'-'), left(coalesce(meta::text,'-'),200) from wa_send_audit where phone like '%7672859610%' and \"createdAt\" > '2026-10-14 07:00' order by \"createdAt\""
echo "-- opt-in rows (phone tail | userId set | status columns)"; q "select column_name from information_schema.columns where table_name='whatsapp_opt_in' order by ordinal_position" | tr '\n' ' '; echo
q "select * from whatsapp_opt_in where phone like '%7672859610%' order by 1 limit 6" | cut -c1-260
echo "-- current account userId: $(q "select \"userId\" from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')")"
