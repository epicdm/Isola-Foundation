#!/bin/bash
# READ-ONLY part 2 of the 9610 state read: subscription/ledger columns, admission queue, Chatwoot conv 599 tail, Uplink conversation bfb21e28. No custom_attributes printed (they hold signed relay binding tokens). No writes.
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1); UD=$(docker ps -q -f name=uplink_uplink-db-prod | head -1)
q()  { docker exec -i $C  psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qc() { docker exec -i $CW psql -U postgres -d isola       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qu() { docker exec -i $UD psql -U uplink  -d uplink       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
AID=$(q "select id from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610') limit 1")
echo "### subscription (lite_plan_subscriptions columns, then rows)"
q "select column_name from information_schema.columns where table_name='lite_plan_subscriptions' order by ordinal_position" | tr '\n' ' '; echo
q "select * from lite_plan_subscriptions where \"liteAccountId\"='$AID'" | cut -c1-300
echo "### minute ledger columns + rows for the user"
q "select column_name from information_schema.columns where table_name='lite_minute_ledger' order by ordinal_position" | tr '\n' ' '; echo
q "select * from lite_minute_ledger where \"userId\" in (select \"userId\" from lite_accounts where id='$AID')" | cut -c1-240 | head -8
echo "### admission queue (undrained, all senders): $(q "select count(*) from lite_admission_queue where drained_at is null") ; for 9610: $(q "select count(*) from lite_admission_queue where sender_phone like '%7672859610%' and drained_at is null")"
q "select reason, count(*) from lite_admission_queue where drained_at is null group by 1"
echo "### lite_admission_log last 24h decision counts by reason (all senders)"
q "select decision||':'||reason, count(*) from lite_admission_log where created_at > now() - interval '24 hours' group by 1 order by 2 desc" | head -8
echo "### Chatwoot conv 599: status/assignee + last 6 messages (type 0 in,1 out,2 activity; first 110 chars)"
qc "select id, status, assignee_id, inbox_id, to_char(last_activity_at,'MM-DD HH24:MI:SS') from conversations where id=599"
qc "select name, id from users where id in (16,20)"
qc "select m.id, to_char(m.created_at,'MM-DD HH24:MI:SS'), m.message_type, left(replace(m.content,E'\n',' / '),110) from messages m where m.conversation_id=599 order by m.id desc limit 6"
echo "### Uplink DB: tables with 'conversation' in the name, then the conversation bfb21e28*"
qu "select table_name from information_schema.tables where table_schema='public' and table_name ilike '%conversation%' order by 1" | tr '\n' ' '; echo
qu "select count(*) from agent_conversations"
qu "select id, status, channel, to_char(created_at,'MM-DD HH24:MI'), to_char(updated_at,'MM-DD HH24:MI') from agent_conversations where id::text like 'bfb21e28%'"
qu "select column_name from information_schema.columns where table_name='agent_conversations' order by ordinal_position" | tr '\n' ' '; echo
