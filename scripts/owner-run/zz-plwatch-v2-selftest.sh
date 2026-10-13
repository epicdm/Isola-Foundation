#!/bin/bash
# pl-watch v2 positive controls with SYNTHETIC non-customer rows in a THROWAWAY database inside the throwaway pgj container (a NEW database name per run; nothing is dropped).
# The real script runs (real alert path = private note in the staff-only conversation 519); only the account/queue tables it reads are the synthetic ones. Production data is never written.
set -u
S=/tmp/pl-watch-v2.py; PGJ=pgj; ST=/tmp/plw-selftest-state.json; DBX=plwst$(date +%s)
CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1)
allnotes() { docker exec $CW psql -U postgres -d isola -X -At -c "select count(*) from messages where conversation_id=597 and private=true" </dev/null; }
docker exec -i $PGJ psql -U postgres -d postgres -X -At -q -c "create database $DBX" || { echo "cannot create throwaway db"; exit 2; }
p() { docker exec -i $PGJ psql -U postgres -d $DBX -X -At -q "$@" ; }
run() { PLW_DB=$PGJ PLW_DBNAME=$DBX PLW_STATE=$ST python3 $S 2>&1 | grep -E "^FAIL|alert private note|acct|admission" | cut -c1-170; }
echo '{"failing": [], "last_mail": 0, "cw_conv": 519}' > $ST
p <<'SQL'
create table lite_accounts (id text, "ownerPhone" text, "createdAt" timestamp, "registeredAt" timestamp, "registrationState" text);
create table lite_admission_queue (id text, sender_phone text, reason text, door text, created_at timestamp, drained_at timestamp);
SQL
echo "throwaway database: $DBX"
echo "T0 control: empty synthetic tables -> expect OK lines and NO note"; N0=$(allnotes); run; echo "notes added: $(( $(allnotes) - N0 )) (expect 0)"
echo "T1 FIRE: one synthetic unregistered account 30 min old (999 area code, not a known test identity)"
p -c "insert into lite_accounts values ('selftestA1xxxxxxxx','19995550101', now()-interval '30 minutes', null, 'pending')"
N1=$(allnotes); run; echo "notes added: $(( $(allnotes) - N1 )) (expect 1)"
echo "T2 DEDUP: run twice more with the same row -> expect 0 new notes"; N2=$(allnotes); run >/dev/null; run >/dev/null; echo "notes added: $(( $(allnotes) - N2 )) (expect 0)"
echo "T3 CONTROLS THAT MUST NOT FIRE: (a) 5-minute-old account, (b) 30-min-old account of a known synthetic 555 identity, (c) 30-min-old ACTIVATED account, (d) 30-min-old retired account"
p -c "insert into lite_accounts values ('selftestA2young00','19995550102', now()-interval '5 minutes', null, 'pending'), ('selftestA3known00','17675550911', now()-interval '30 minutes', null, 'pending'), ('selftestA4active0','19995550103', now()-interval '30 minutes', now(), 'activated'), ('selftestA5retired','19995550104-retired-1', now()-interval '30 minutes', null, 'pending')"
N3=$(allnotes); run; echo "notes added: $(( $(allnotes) - N3 )) (expect 0; only selftestA1 is still failing)"
echo "T4 RECOVERY: the stalled account registers -> expect exactly 1 recovery note"
p -c "update lite_accounts set \"registeredAt\"=now(), \"registrationState\"='activated' where id='selftestA1xxxxxxxx'"
N4=$(allnotes); run; echo "notes added: $(( $(allnotes) - N4 )) (expect 1)"
echo "T5 FIRE (admission): undrained queue row, unknown identity -> expect 1 note; then dedup; then a known 555 negative-control row -> 0"
p -c "insert into lite_admission_queue values ('selftestQ1xxxxxxxx','19995550105','country_not_open','concierge', now(), null)"
N5=$(allnotes); run; echo "notes added: $(( $(allnotes) - N5 )) (expect 1)"
N6=$(allnotes); run >/dev/null; echo "dedup notes added: $(( $(allnotes) - N6 )) (expect 0)"
p -c "insert into lite_admission_queue values ('selftestQ2known000','17675550912','country_not_open','flow', now(), null)"
N7=$(allnotes); run >/dev/null; echo "known-test queue row notes added: $(( $(allnotes) - N7 )) (expect 0)"
echo "T6 RECOVERY (admission): the queue row is drained -> expect 1 recovery note"
p -c "update lite_admission_queue set drained_at=now() where id='selftestQ1xxxxxxxx'"
N8=$(allnotes); run; echo "notes added: $(( $(allnotes) - N8 )) (expect 1)"
echo "== final selftest state (failing list must be empty)"; cat $ST; echo
echo "== the selftest notes as the staff see them (newest 5; heads only)"; docker exec $CW psql -U postgres -d isola -X -At -F ' | ' -c "select id, to_char(created_at,'HH24:MI:SS'), left(replace(content,E'\n',' '),130) from messages where conversation_id=597 and private=true order by id desc limit 5" </dev/null
rm -f $ST
