#!/bin/bash
F=/home/epicadmin/plprod/runtime-flags.json; FIN=f66191694aa5693764a3a5d06e827d1e48793a9a8c4472b262ef5e920fa8a68c
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
probe() { docker exec -i -w /app -e WA=$1 -e EP=$2 $P node - < /tmp/zz-probe.js 2>&1 | tail -1; }
echo "== existing-customer support (synthetic signed reads for the protected owner line, no admission involved)"
for ep in offer account/line-status account/balance account/journey; do echo "   $(probe 17672859610 $ep)"; done
echo "== KILL SWITCH after opening: PL_CONCIERGE_SVC_ENABLED=false in place (positive control = same probe answers before and after)"
echo "   before: $(probe 17672859610 offer)"
python3 - <<'PY'
import json
F="/home/epicadmin/plprod/runtime-flags.json"; d=json.load(open(F)); d["PL_CONCIERGE_SVC_ENABLED"]=False
open(F,"w").write(json.dumps(d,indent=2,ensure_ascii=False)+"\n")
PY
sleep 12; echo "   killed: $(probe 17672859610 offer)"
cat /tmp/flags-final.json > $F; sleep 12
echo "   restored: $(probe 17672859610 offer)   flags sha: $(sha256sum $F | cut -c1-64) $( [ "$(sha256sum $F | cut -c1-64)" = "$FIN" ] && echo '== packet final sha' || echo DIFFERENT)"
SG=$(docker exec -i $(docker ps -q -f name=uplink_uplink-db-prod | head -1) sh -c 'psql -U "$POSTGRES_USER" -d uplink -X -At -c "select spent_micro_usd, reserved_micro_usd, enabled from public_turn_spend_gates limit 1"' </dev/null)
echo "spend gate AFTER (spent_micro | reserved | enabled): $SG"
