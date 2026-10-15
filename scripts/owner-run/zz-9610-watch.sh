#!/bin/bash
# READ-ONLY change detector for the owner's 9610 new-customer test (run as root on host04). Exits on the FIRST change after its baseline, printing the diff; max $1 seconds (default 900).
MAX=${1:-900}
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1); UD=$(docker ps -q -f name=uplink_uplink-db-prod | head -1); PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
q()  { docker exec -i $C  psql -U postgres -d isolav2_prod -X -At -F '|' -c "$1" </dev/null 2>&1 | tr '\n' ';'; }
qc() { docker exec -i $CW psql -U postgres -d isola       -X -At -F '|' -c "$1" </dev/null 2>&1 | tr '\n' ';'; }
qu() { docker exec -i $UD psql -U uplink  -d uplink       -X -At -F '|' -c "$1" </dev/null 2>&1 | tr '\n' ';'; }
snap() {
  echo "chatwoot_msgs(max id|count)=$(qc "select coalesce(max(m.id),0), count(*) from messages m join conversations c on c.id=m.conversation_id where c.contact_id in (98,541) and m.created_at > '2026-10-14 07:19'")"
  echo "chatwoot_convs(display|status|inbox)=$(qc "select display_id, status, inbox_id from conversations where contact_id=98 and created_at > '2026-10-14 07:19' order by id")"
  echo "concierge_audit(9610 since 06:58: n|last endpoint:code)=$(q "select count(*), coalesce((array_agg(endpoint||':'||code order by created_at desc))[1],'-') from pl_concierge_audit where wa_last4='9610' and rid not like 'cw-offer-once%' and created_at > '2026-10-14 07:19'")"
  echo "wa_send_audit(n|last purpose:decision:dispatch)=$(q "select count(*), coalesce((array_agg(purpose||':'||decision||':'||coalesce(\"dispatchStatus\",'-') order by \"createdAt\" desc))[1],'-') from wa_send_audit where phone like '%7672859610%' and \"createdAt\" > '2026-10-14 06:58'")"
  echo "admission_log(n|last decision:reason:door)=$(q "select count(*), coalesce((array_agg(decision||':'||reason||':'||door order by created_at desc))[1],'-') from lite_admission_log where sender_phone like '%7672859610%' and created_at > '2026-10-14 07:19'")"
  echo "account(live n|did tail|state|registeredAt|install-reported)=$(q "select count(*), coalesce(max(right(did,4)),'-'), coalesce(max(\"registrationState\"),'-'), coalesce(max(\"registeredAt\")::text,'-'), coalesce(max(\"installSelfReportedAt\")::text,'-') from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')")"
  echo "uplink_convs(new since 06:58 n|max turns)=$(qu "select count(*), coalesce(max(turn_count),0) from agent_conversations where started_at > '2026-10-14 06:58'")"
}
snap > /tmp/w9610.base
end=$((SECONDS+MAX))
while [ $SECONDS -lt $end ]; do
  sleep 3; snap > /tmp/w9610.now
  if ! diff -q /tmp/w9610.base /tmp/w9610.now >/dev/null; then echo "CHANGE at $(date -u +%T):"; diff /tmp/w9610.base /tmp/w9610.now; cp /tmp/w9610.now /tmp/w9610.base; exit 0; fi
done
echo "NO-CHANGE after ${MAX}s"
