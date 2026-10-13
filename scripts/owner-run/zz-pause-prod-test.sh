#!/bin/bash
# (c) PAUSE SWITCH ON PRODUCTION, with controls. Run on host04 as root. The ONLY production change is the LITE_ADMISSION_PAUSED key in runtime-flags.json for about 25 seconds; the file is restored byte-for-byte from the pre-release snapshot and the sha256 is asserted equal.
# Every request is SYNTHETIC (555-exchange numbers, production secret in-process = simulated protocol control). Admission stays closed, so nothing can provision either way.
set -u
B=/var/backups/admission-release-20261013; F=/home/epicadmin/plprod/runtime-flags.json
WANT=$(cut -c1-64 $B/runtime-flags.sha256); [ "$(sha256sum $F | cut -c1-64)" = "$WANT" ] || { echo "ABORT: flags file differs from the pre-release snapshot"; exit 9; }
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "$1" </dev/null; }
probe() { docker exec -i -e PHONE=$1 $P sh -c 'cd /app && node -' < /tmp/zz-pause-prod-probe.js 2>&1 | tail -1; sleep 2; echo "   gate decision recorded: $(q "select decision||':'||reason||':'||door||coalesce(':paused='||(detail->>'paused'),'') from lite_admission_log where sender_phone='$1' order by created_at desc limit 1")"; }
echo "0) baseline flags sha == snapshot: OK ($WANT)"
echo "1) PAUSE OFF (current state): expect a queue decision with paused=false"; probe 17675559901
echo "2) PAUSE ON: set LITE_ADMISSION_PAUSED=true in the flags file (every other key untouched), wait for the 8 s cache"
python3 - <<'PY'
import json
f='/home/epicadmin/plprod/runtime-flags.json'; d=json.load(open(f)); d['LITE_ADMISSION_PAUSED']=True
json.dump(d, open(f,'w'), indent=2)
PY
sleep 11
probe 17675559902
echo "3) PAUSE OFF again: restore the snapshot byte-for-byte, wait for the cache"
cp -p $B/runtime-flags.json.pre-release $F; sleep 11
probe 17675559903
GOT=$(sha256sum $F | cut -c1-64); echo "4) final flags sha: $GOT  $( [ "$GOT" = "$WANT" ] && echo 'IDENTICAL to the pre-release snapshot' || echo 'DIFFERS - RESTORE FAILED' ) | stat: $(stat -c '%a %U:%G %s' $F)"
