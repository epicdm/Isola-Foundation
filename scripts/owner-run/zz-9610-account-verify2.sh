#!/bin/bash
# READ-ONLY: lumen/odoo bind fields on the owner's new account and the minute-ledger / trial grant rows.
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null 2>&1; }
q "select 'lumenSeatBindError='||coalesce(left(\"lumenSeatBindError\",90),'-')||' attempted='||(\"lumenSeatBindAttemptedAt\" is not null)||' bound='||(\"lumenSeatBoundAt\" is not null)||' | odooOutcome='||coalesce(\"odooPartnerBindOutcome\",'-')||' odooPartner='||coalesce(\"odooPartnerId\"::text,'-') from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610')"
echo "minute ledger rows for the account:"; q "select type, minutes, destination, to_char(\"createdAt\",'HH24:MI:SS') from lite_minute_ledger where \"liteAccountId\"=(select id from lite_accounts where \"ownerPhone\" in ('17672859610','+17672859610'))"
echo "admission log for 9610 since 07:18Z:"; q "select to_char(created_at,'HH24:MI:SS'), decision||':'||reason||':'||door from lite_admission_log where sender_phone like '%7672859610%' and created_at > '2026-10-14 07:18' order by created_at"
echo "flags sha now: $(sha256sum /home/epicadmin/plprod/runtime-flags.json | cut -c1-8)  (window open = e9dad18d; paused = 575bc9fb)"
