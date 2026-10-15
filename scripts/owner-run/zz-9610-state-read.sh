#!/bin/bash
# READ-ONLY state of the OWNER's fixture line 9610 (17672859610) across plsvc DB, Chatwoot and the Uplink DB, with positive controls. Run as root on host04. No writes. Phones masked to last 4; no secrets selected.
PH=17672859610
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1); UD=$(docker ps -q -f name=uplink_uplink-db-prod | head -1)
q()  { docker exec -i $C  psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qc() { docker exec -i $CW psql -U postgres -d isola       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qu() { docker exec -i $UD psql -U uplink  -d uplink       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
echo "== $(date -u +%FT%TZ)"
echo "### 1. lite_accounts rows for the phone (both forms) and ANY row sharing its DID / magnusUserId (positive control: row count must be >=1)"
q "select id, \"userId\", right(\"ownerPhone\",4) ph, did, \"magnusUserId\" mu, \"magnusSipId\" sip, \"magnusDidId\" didid, \"magnusDiddestinationId\" dd, \"registrationState\" st, to_char(\"createdAt\",'YYYY-MM-DD HH24:MI') created, to_char(\"registeredAt\",'YYYY-MM-DD HH24:MI') registered from lite_accounts where \"ownerPhone\" in ('$PH','+$PH')"
DID=$(q "select did from lite_accounts where \"ownerPhone\" in ('$PH','+$PH') limit 1"); MU=$(q "select \"magnusUserId\" from lite_accounts where \"ownerPhone\" in ('$PH','+$PH') limit 1"); UIDV=$(q "select \"userId\" from lite_accounts where \"ownerPhone\" in ('$PH','+$PH') limit 1"); AID=$(q "select id from lite_accounts where \"ownerPhone\" in ('$PH','+$PH') limit 1")
echo "other accounts sharing DID=$DID: $(q "select count(*) from lite_accounts where did='$DID' and \"ownerPhone\" not in ('$PH','+$PH')")   sharing magnusUserId=$MU: $(q "select count(*) from lite_accounts where \"magnusUserId\"='$MU' and \"ownerPhone\" not in ('$PH','+$PH')")   total accounts: $(q "select count(*) from lite_accounts") ; unretired: $(q "select count(*) from lite_accounts where \"ownerPhone\" not like '%retired%'")"
echo "### 2. every table with a userId / accountId column: row count for THIS account (control line = lite_accounts)"
for T in $(q "select table_name from information_schema.columns where table_schema='public' and column_name in ('userId','user_id') order by 1"); do
  col=$(q "select column_name from information_schema.columns where table_schema='public' and table_name='$T' and column_name in ('userId','user_id') limit 1")
  n=$(q "select count(*) from \"$T\" where \"$col\"='$UIDV'" 2>&1 | head -1); [ "$n" != "0" ] && echo "   $T.$col = $n"
done
for T in $(q "select table_name from information_schema.columns where table_schema='public' and column_name in ('accountId','liteAccountId','lite_account_id','account_id') order by 1"); do
  col=$(q "select column_name from information_schema.columns where table_schema='public' and table_name='$T' and column_name in ('accountId','liteAccountId','lite_account_id','account_id') limit 1")
  n=$(q "select count(*) from \"$T\" where \"$col\"='$AID'" 2>&1 | head -1); [ "$n" != "0" ] && echo "   $T.$col = $n"
done
echo "### 3. phone-keyed tables (rows mentioning the phone; counts)"
for T in $(q "select table_name||'.'||column_name from information_schema.columns where table_schema='public' and data_type in ('text','character varying') and (column_name ilike '%phone%' or column_name in ('waId','wa_id','summary','sender_phone')) order by 1"); do
  t=${T%%.*}; c=${T##*.}; n=$(q "select count(*) from \"$t\" where \"$c\" like '%7672859610%'" 2>&1 | head -1); [ "$n" != "0" ] && echo "   $t.$c = $n"
done
echo "### 4. subscription / minutes / wallet facts for the account (non-secret)"
q "select 'sub', code, status, to_char(\"startsAt\",'MM-DD HH24:MI') s, to_char(\"expiresAt\",'MM-DD HH24:MI') e from lite_subscriptions where \"accountId\"='$AID'" | head -5
q "select 'ledger', kind, minutes, to_char(\"createdAt\",'MM-DD HH24:MI') from lite_minute_ledger where \"userId\"='$UIDV' order by \"createdAt\"" | head -8
echo "### 5. Chatwoot: contact(s) for the phone, their conversations, last message times (positive control: contact 109 for the other number)"
qc "select 'control contact 109 exists:', count(*) from contacts where id=109"
qc "select 'contact', id, right(phone_number,4), identifier is not null as has_ident, to_char(created_at,'MM-DD HH24:MI') from contacts where phone_number like '%7672859610%' or identifier like '%7672859610%'"
qc "select 'conv', c.id, c.inbox_id, c.status, c.assignee_id, c.contact_id, to_char(c.created_at,'MM-DD HH24:MI') cr, to_char(c.last_activity_at,'MM-DD HH24:MI') la, (select count(*) from messages m where m.conversation_id=c.id) msgs, c.custom_attributes::text from conversations c where c.contact_id in (select id from contacts where phone_number like '%7672859610%' or identifier like '%7672859610%') order by c.id"
qc "select 'inbox 11 lock_to_single_conversation:', lock_to_single_conversation from inboxes where id=11"
echo "### 6. Uplink DB: conversations bound to the Chatwoot conversation(s) / the bfb21e28 conversation (counts + status only)"
qu "select 'control agents', count(*) from agents"
qu "select table_name from information_schema.columns where table_schema='public' and column_name='external_id' or (column_name ilike '%chatwoot%') order by 1" | head -8
