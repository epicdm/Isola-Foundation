#!/bin/bash
# Read-only state of the fixture walk (host04, root): DB rows, Magnus objects (safe fields), audit trail, sends. Arg1 = phone digits.
PH=${1:-17675550911}
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null; }
echo "accounts (live rows for ***${PH: -4}): $(q "select count(*) from lite_accounts where \"ownerPhone\" in ('$PH','+$PH')")   attempts joined to the account's user: $(q "select count(*) from lite_provision_attempts a join lite_accounts l on l.\"userId\"=a.user_id where l.\"ownerPhone\" in ('$PH','+$PH')")  attempts created in the last 30 min (all users): $(q "select count(*) from lite_provision_attempts where created_at > now() - interval '30 minutes'")"
q "select 'row: did='||did||' magnusUser='||\"magnusUserId\"||' sip='||coalesce(\"magnusSipId\",'-')||' didId='||coalesce(\"magnusDidId\",'-')||' dd='||coalesce(\"magnusDiddestinationId\",'-')||' state='||coalesce(\"registrationState\",'-')||' createdAt='||\"createdAt\" from lite_accounts where \"ownerPhone\" in ('$PH','+$PH')"
echo "admission log (decision:reason:door:paused) for ***${PH: -4}:"; q "select '   '||decision||':'||reason||':'||door||coalesce(':paused='||(detail->>'paused'),'')||' @'||to_char(created_at,'HH24:MI:SS') from lite_admission_log where sender_phone='$PH' order by created_at"
echo "admission queue rows (undrained): $(q "select count(*) from lite_admission_queue where sender_phone='$PH' and drained_at is null")"
echo "wa_send_audit rows for the number (decision/dispatch/has_meta_id):"; q "select '   '||purpose||' '||decision||' '||coalesce(\"dispatchStatus\",'-')||' meta_id='||(\"metaMessageId\" is not null)::text from wa_send_audit where phone like '%$PH%' and \"createdAt\" > now() - interval '3 hours' order by \"createdAt\""
UID_=$(q "select \"magnusUserId\" from lite_accounts where \"ownerPhone\" in ('$PH','+$PH') limit 1")
[ -n "$UID_" ] && docker exec -w /app $P node /tmp/fx-magnus.js "$UID_,0,0,0" </dev/null 2>&1 | cut -c1-360 | head -6
