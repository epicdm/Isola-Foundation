#!/bin/bash
# READ-ONLY trace of the owner's 9610 test conversation: Chatwoot messages (no custom_attributes), audit rows, sends, admission, account.
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1)
q()  { docker exec -i $C  psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qc() { docker exec -i $CW psql -U postgres -d isola       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
echo "== $(date -u +%T)"
qc "select m.id, to_char(m.created_at,'HH24:MI:SS'), m.message_type, left(replace(m.content,E'\n',' / '),420) from messages m join conversations c on c.id=m.conversation_id where c.contact_id in (98,541) and m.created_at > '2026-10-14 07:00' order by m.id"
echo "-- concierge audit (excluding pl-watch probe)"; q "select to_char(created_at,'HH24:MI:SS'), endpoint, code, http_status, rid from pl_concierge_audit where wa_last4='9610' and rid not like 'cw-offer-once%' and created_at > '2026-10-14 07:00' order by created_at"
echo "-- wa_send_audit"; q "select to_char(\"createdAt\",'HH24:MI:SS'), purpose, decision, coalesce(\"dispatchStatus\",'-'), coalesce(\"errorCode\",'-') from wa_send_audit where phone like '%7672859610%' and \"createdAt\" > '2026-10-14 07:00' order by \"createdAt\""
echo "-- admission log"; q "select to_char(created_at,'HH24:MI:SS'), decision, reason, door from lite_admission_log where sender_phone like '%7672859610%' and created_at > '2026-10-14 07:00' order by created_at"
echo "-- live account"; q "select right(did,4), \"registrationState\", \"registeredAt\", \"installSelfReportedAt\", \"magnusUserId\" from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')"
