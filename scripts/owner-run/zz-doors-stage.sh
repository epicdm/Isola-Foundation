#!/bin/bash
# ISOLATED STAGING of the admission candidate image (the digest now deployed): five provisioning doors x four configurations. Run on host04 as root (bash script file; docker commands need root).
# All requests are SYNTHETIC (test RSA key, test secrets, 555-exchange numbers); Magnus is a STUB that answers did/read with an empty inventory and refuses every write (so no provisioning can complete); the staging database is the empty schema-only copy. Nothing touches production data or a customer.
set -u
IMG=localhost:5000/pl/plsvc@sha256:5acad2e83272754745bf088421fba3e2bf1db390f87cd3259f4a5423aa600115
R=/var/tmp/plstage-033550/flowh; W=/var/tmp/plstage-doors; mkdir -p $W
[ -f $R/env_secret ] && [ -f $R/pub.pem ] || { echo "staging keys missing"; exit 3; }
docker ps -aq -f name=^fakemagnus3$ | grep -q . && { echo 'fakemagnus3 exists'; exit 2; }
for n in doors3O doors3P; do docker ps -aq -f name=^$n$ | grep -q . && { echo "$n exists - remove first"; exit 2; }; done
# derived env: the staging env + an INTERNAL_SECRET (random, staging only) + the Meta phone-number id the PL assertion door allowlists (public id)
grep -v '^PREVIEW_SIMULATE_PROVISIONING=' $R/env_secret > $W/env_doors; printf 'INTERNAL_SECRET=%s\nPL_CONCIERGE_PNID_ALLOWLIST=1023804347491554\nMAGNUS_URL=http://fakemagnus3:8080\nMAGNUS_API_KEY=staging-test-key\nMAGNUS_API_SECRET=staging-test-secret\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> $W/env_doors; chmod 600 $W/env_doors
OPEN='"LITE_ADMISSION_OPEN_COUNTRY_PREFIXES":["1767"],"LITE_ADMISSION_COUNTRY_ALLOWLIST":["17675553101","17675553201","17675553301","17675553401","17675553501","17675552101","17675552201","17675552301","17675552401","17675552501"],"PL_CONCIERGE_SVC_ENABLED":true,"PL_CONCIERGE_SVC_PROVISION_ENABLED":true,"LITE_SELF_SERVE_ENABLED":true'
echo "{ $OPEN }" > $W/flags_open.json
echo "{ $OPEN, \"LITE_ADMISSION_PAUSED\": true }" > $W/flags_paused.json
echo '{not json' > $W/flags_malformed.json
cat > $W/fakemagnus.js <<'EOT'
const http = require('http');
http.createServer((rq, rs) => { let b = ''; rq.on('data', (c) => b += c); rq.on('end', () => { const m = /\/index\.php\/([a-zA-Z]+)\/([a-zA-Z]+)/.exec(rq.url || ''); rs.writeHead(200, { 'content-type': 'application/json' });
  if (m && m[1] === 'did' && m[2] === 'read') return rs.end(JSON.stringify({ success: true, rows: [], total: 0 }));
  return rs.end(JSON.stringify({ success: false, status: 'error', message: 'staging stub: no writes' })); }); }).listen(8080, () => console.log('fakemagnus listening'));
EOT
docker run -d --name fakemagnus3 --network plstage -v $W/fakemagnus.js:/s.js:ro node:22-slim node /s.js >/dev/null
mk() { # name flagsfile|none
  local extra=(); [ "$2" != none ] && extra=(-v $W/$2:/app/data/runtime-flags.json:ro)
  docker run -d --name $1 --network plstage --cpus 1 -m 1536m --env-file $W/env_doors -v $R:/h:ro "${extra[@]}" $IMG node ./node_modules/next/dist/bin/next start >/dev/null
}
mk doors3O flags_open.json; mk doors3P flags_paused.json
for i in $(seq 1 45); do sleep 2; ok=1; for n in doors3O doors3P; do docker logs $n 2>&1 | grep -q "Ready in" || ok=0; done; [ $ok = 1 ] && break; done
for n in doors3O doors3P; do echo "$n: $(docker ps --format '{{.Status}}' -f name=^$n$)"; done
DESC=(zero "1 legacy Flow WELCOME" "2 PL signup Flow v7.1 CONFIRM" "3 /api/lite/provision (internal door)" "4 operator-provision" "5 pl-concierge lines/provision")
run_scn() { # name label scnno
  echo "######## $2"
  for d in 1 2 3 4 5; do
    OUT=$(docker exec -i -e DOOR=$d -e PHONE=1767555${3}${d}01 $1 sh -c 'cd /app && node -' < /tmp/zz-doors-harness.js 2>&1 | tail -1)
    echo "  door ${DESC[$d]}: $OUT" | cut -c1-520
  done
}
run_scn doors3O "A) EXPLICITLY ENABLED (control: country open, provisioning on, the Magnus stub reports an inventory) - each door must ADMIT and start a provisioning attempt" 5
run_scn doors3P "B) PAUSED (country open AND the sender allowlisted AND provisioning on, LITE_ADMISSION_PAUSED=true) - every door must be stopped" 2
