#!/bin/bash
F=/home/epicadmin/plprod/runtime-flags.json; FIN=f66191694aa5693764a3a5d06e827d1e48793a9a8c4472b262ef5e920fa8a68c
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
Q() { docker exec -i $(docker ps -q -f name=uplink_plsub_restore_db | head -1) psql -U postgres -d isolav2_prod -X -At -F ' | ' -c "$1" </dev/null; }
SG() { docker exec -i $(docker ps -q -f name=uplink_uplink-db-prod | head -1) sh -c 'psql -U "$POSTGRES_USER" -d uplink -X -At -c "select spent_micro_usd, reserved_micro_usd, enabled from public_turn_spend_gates limit 1"' </dev/null; }
sed "s/new Set(\['17675550911', '17675550912'\])/new Set(['17675550911', '17675550912', '14155559401'])/" /tmp/zz-fx-walk.js > /tmp/zz-fx-walk2.js
echo "spend gate BEFORE (spent_micro | reserved | enabled): $(SG)"
echo "== (1) NEGATIVE CONTROL on production, flags = FINAL: SYNTHETIC non-1767 number 14155559401"
docker exec -i -w /app -e MODE=o4 -e PHONE=14155559401 $P node - < /tmp/zz-fx-walk2.js 2>&1 | tail -1 | cut -c1-230
Q "select decision||':'||reason||':'||door||':paused='||(detail->>'paused') from lite_admission_log where sender_phone='14155559401' order by created_at desc limit 1"
echo "   accounts for it: $(Q "select count(*) from lite_accounts where \"ownerPhone\" like '%14155559401%'")  total lite_accounts: $(Q 'select count(*) from lite_accounts')"
echo "== (2) PAUSE SWITCH after opening (in place): paused=true, synthetic non-1767 number"
python3 - <<'PY'
import json
F="/home/epicadmin/plprod/runtime-flags.json"; d=json.load(open(F)); d["LITE_ADMISSION_PAUSED"]=True
open(F,"w").write(json.dumps(d,indent=2,ensure_ascii=False)+"\n")
PY
sleep 12
docker exec -i -w /app -e MODE=o4 -e PHONE=14155559401 $P node - < /tmp/zz-fx-walk2.js 2>&1 | tail -1 | cut -c1-120
Q "select decision||':'||reason||':'||door||':paused='||(detail->>'paused') from lite_admission_log where sender_phone='14155559401' order by created_at desc limit 1"
cat /tmp/flags-final.json > $F; sleep 12
echo "   paused removed; flags sha now: $(sha256sum $F | cut -c1-64) $( [ "$(sha256sum $F | cut -c1-64)" = "$FIN" ] && echo '== packet final sha' || echo 'DIFFERENT')"
docker exec -i -w /app -e MODE=o4 -e PHONE=14155559401 $P node - < /tmp/zz-fx-walk2.js 2>&1 | tail -1 | cut -c1-60 >/dev/null
Q "select decision||':'||reason||':'||door||':paused='||(detail->>'paused') from lite_admission_log where sender_phone='14155559401' order by created_at desc limit 1" | sed 's/^/   after unpause: /'
