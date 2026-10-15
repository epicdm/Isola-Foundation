#!/bin/bash
# READ-ONLY read-back after the 9610 reset: account counts, 9610 state, protected lines untouched, Chatwoot conv 599. Phones masked.
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1)
q()  { docker exec -i $C  psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
qc() { docker exec -i $CW psql -U postgres -d isola       -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
echo "accounts total: $(q 'select count(*) from lite_accounts') (was 70) ; unretired: $(q "select count(*) from lite_accounts where \"ownerPhone\" not like '%retired%'") (was 42, expect 41)"
echo "live accounts for 9610 (expect 0): $(q "select count(*) from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')")"
q "select 'retired row: id='||id||' phone_tail='||right(\"ownerPhone\",22)||' did='||did||' state='||coalesce(\"registrationState\",'-') from lite_accounts where \"ownerPhone\" like '17672859610-retired-%' order by \"createdAt\" desc limit 2"
echo "subscription row kept: $(q "select count(*)||' (state '||string_agg(state,',')||')' from lite_plan_subscriptions where \"liteAccountId\"='cmv3bl97b003h01l8ilc9mycm'")"
echo "any live account still holding DID 17678185098 (expect 0): $(q "select count(*) from lite_accounts where did='17678185098' and \"ownerPhone\" not like '%retired%'")"
echo "protected lines (unretired accounts by owner phone tail):"
for t in 8440 4961 2970; do q "select '  ...$t: '||count(*)||' unretired; dids '||coalesce(string_agg(did,','),'-')||'; states '||coalesce(string_agg(coalesce(\"registrationState\",'-'),','),'-') from lite_accounts where \"ownerPhone\" like '%$t' and \"ownerPhone\" not like '%retired%'"; done
echo "reset audit rows for 9610 (last 3): "; q "select decision||':'||reason||' @'||to_char(created_at,'HH24:MI:SS') from lite_admission_log where sender_phone like '%7672859610%' and created_at > now() - interval '15 minutes' order by created_at"
echo "Chatwoot conv 599: $(qc "select 'status='||status||' assignee='||coalesce(assignee_id::text,'-') from conversations where id=599")"
echo "runtime flags sha (expect 575bc9fb..4cfe): $(sha256sum /home/epicadmin/plprod/runtime-flags.json | cut -c1-8)...$(sha256sum /home/epicadmin/plprod/runtime-flags.json | cut -c61-64)"
