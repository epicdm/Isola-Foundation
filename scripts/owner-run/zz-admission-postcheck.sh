#!/bin/bash
# POST-RELEASE state check (host04, root): protected rows and Magnus objects against the pre-release hashes, flags against the snapshot, pl-watch, alert notes since the deploy.
set -u
B=/var/backups/admission-release-20261013; F=/home/epicadmin/plprod/runtime-flags.json
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1); CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "$1" </dev/null; }
echo "flags sha now: $(sha256sum $F | cut -c1-64)  snapshot: $(cut -c1-64 $B/runtime-flags.sha256)  -> $( [ "$(sha256sum $F | cut -c1-64)" = "$(cut -c1-64 $B/runtime-flags.sha256)" ] && echo IDENTICAL || echo DIFFERENT )"
NOW=$(q "select md5(string_agg(t::text, '|' order by id)) || '|' || count(*) from (select id, \"userId\", did, \"magnusUserId\", \"magnusSipId\", \"magnusDidId\", \"magnusDiddestinationId\", \"ownerPhone\", \"registrationState\", \"registeredAt\", \"createdAt\" from lite_accounts where \"ownerPhone\" like '%2859610' and \"ownerPhone\" not like '%retired%' or \"ownerPhone\" like '%4158408440' and \"ownerPhone\" not like '%retired%') t")
echo "protected lite_accounts rows (9610 -> ...5098, 8440 -> ...5099): now $NOW  before $(cat $B/protected-lite-accounts.md5)  -> $( [ "$NOW" = "$(cat $B/protected-lite-accounts.md5)" ] && echo UNCHANGED || echo CHANGED )"
echo "lite_accounts total: now $(q 'select count(*) from lite_accounts') before $(cat $B/lite_accounts.count)"
UIDS=$(q "select string_agg(\"magnusUserId\", ',') from lite_accounts where (\"ownerPhone\" like '%2859610' or \"ownerPhone\" like '%4158408440') and \"ownerPhone\" not like '%retired%'")
docker cp /tmp/mg-prot.js $P:/tmp/mg-prot.js >/dev/null; M=$(docker exec $P node /tmp/mg-prot.js "$UIDS" </dev/null)
echo "protected Magnus objects (users $UIDS incl. user 614): now [$M] before [$(cat $B/protected-magnus.md5)]  -> $( [ "$M" = "$(cat $B/protected-magnus.md5)" ] && echo UNCHANGED || echo CHANGED )"
echo "conversation 521 messages (Chatwoot display id 521): $(docker exec -i $CW psql -U postgres -d isola -X -At -c "select count(*) from messages m join conversations c on c.id=m.conversation_id where c.account_id=2 and c.display_id=521" </dev/null)  last message id: $(docker exec -i $CW psql -U postgres -d isola -X -At -c "select max(m.id) from messages m join conversations c on c.id=m.conversation_id where c.account_id=2 and c.display_id=521" </dev/null)"
echo "-- pl-watch run now:"; python3 /usr/local/lib/pl-watch/pl-watch.py --dry-run 2>&1 | grep -E "^(OK|FAIL)|dry-run" | cut -c1-150
echo "-- staff-private alert notes since the deploy window (07:35Z today):"; docker exec -i $CW psql -U postgres -d isola -X -At -F ' | ' -c "select id, to_char(created_at,'HH24:MI:SS'), left(replace(content,E'\n',' '),90) from messages where conversation_id=597 and private=true and created_at > now()::date + interval '07:35' order by id" </dev/null
echo "-- synthetic probe rows left behind in production by the pause test (555 numbers, excluded from alerts by design):"; q "select count(*) from lite_admission_queue where sender_phone like '1767555990%' and drained_at is null"
