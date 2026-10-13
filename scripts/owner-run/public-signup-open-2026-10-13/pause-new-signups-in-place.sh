#!/bin/bash
# NEW-SIGNUP PAUSE (LITE_ADMISSION_PAUSED=true) on host04, the documented IN-PLACE procedure for the single-file bind mount (cat > file, NEVER a rename).
# usage: pause-new-signups-in-place.sh pause | resume      (resume = the captured reversal: write the pre-pause bytes back in place)
# Existing-customer support keeps working: the pause is the FIRST admission gate only (order: paused -> per-sender cap -> hourly/daily ceiling -> country -> DID floor).
set -u
F=/home/epicadmin/plprod/runtime-flags.json; B=/var/backups/admission-release-20261013; PRE=$B/runtime-flags.json.pre-pause-20261013
FIN=f66191694aa5693764a3a5d06e827d1e48793a9a8c4472b262ef5e920fa8a68c
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
Q() { docker exec -i $(docker ps -q -f name=uplink_plsub_restore_db | head -1) psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null; }
S() { echo "[$(date -u +%FT%TZ)] $*"; }
walk() { docker exec -i -w /app -e MODE=o4 -e PHONE=$1 $P node - < /tmp/zz-fx-walk.js 2>&1 | tail -1 | cut -c1-200; Q "select decision||':'||reason||':'||door||':paused='||coalesce(detail->>'paused','') from lite_admission_log where sender_phone='$1' order by created_at desc limit 1" | sed 's/^/   admission log: /'; }
MODE=${1:-}
if [ "$MODE" = "resume" ]; then
  [ -e $PRE ] || { echo "no pre-pause backup"; exit 2; }
  S "RESUME: writing the pre-pause bytes back IN PLACE"; cat $PRE > $F; sleep 12
  S "flags sha now $(sha256sum $F | cut -c1-64) (expect $FIN) | paused key present: $(grep -c LITE_ADMISSION_PAUSED $F)"; exit 0
fi
[ "$MODE" = "pause" ] || { echo "usage: pause|resume"; exit 2; }
S "BEFORE: flags sha $(sha256sum $F | cut -c1-64) (expect $FIN) | paused key present: $(grep -c LITE_ADMISSION_PAUSED $F)"
[ "$(sha256sum $F | cut -c1-64)" = "$FIN" ] || { echo "ABORT: flags not at the expected final sha"; exit 9; }
mkdir -p $B; [ -e $PRE ] || cp -p $F $PRE
S "REVERSAL captured: $PRE sha $(sha256sum $PRE | cut -c1-64); reversal command: 'cat $PRE > $F' (or: bash $0 resume)"
S "accounts total BEFORE: $(Q 'select count(*) from lite_accounts')"
echo "== positive control BEFORE the pause (flags open): SYNTHETIC 1767 number 17675550912 (provision disabled: nothing is allocated)"
walk 17675550912
python3 - <<'PY'
import json
F = "/home/epicadmin/plprod/runtime-flags.json"; d = json.load(open(F)); d["LITE_ADMISSION_PAUSED"] = True
open("/tmp/flags-paused.json", "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
S "writing the paused flags IN PLACE (cat >, same inode): inode before $(stat -c %i $F)"
cat /tmp/flags-paused.json > $F
S "inode after $(stat -c %i $F) | sha $(sha256sum $F | cut -c1-64) | read-back: $(python3 -c "import json;d=json.load(open('$F'));print('LITE_ADMISSION_PAUSED =', d.get('LITE_ADMISSION_PAUSED'), '| other keys unchanged:', {k:v for k,v in d.items() if k!='LITE_ADMISSION_PAUSED'}==json.load(open('$PRE')))")"
sleep 12
echo "== AFTER the pause: the same synthetic new-signup attempt must get the PAUSED decision, nothing allocated"
walk 17675550912
S "accounts total AFTER: $(Q 'select count(*) from lite_accounts') | accounts for the synthetic number: $(Q "select count(*) from lite_accounts where \"ownerPhone\" like '%17675550912%'")"
S "container sees the file: $(docker exec $P sh -c 'grep -c LITE_ADMISSION_PAUSED /app/runtime-flags.json 2>/dev/null || echo path-n/a')"
