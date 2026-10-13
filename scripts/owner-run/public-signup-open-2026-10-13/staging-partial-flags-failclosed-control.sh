#!/bin/bash
# Partial / empty / malformed flags file -> must resolve to CLOSED (queue). Isolated staging twin of the DEPLOYED image (digest 5acad2e8); SYNTHETIC numbers only; Magnus stub; no production file touched.
IMG=localhost:5000/pl/plsvc@sha256:5acad2e83272754745bf088421fba3e2bf1db390f87cd3259f4a5423aa600115
R=/var/tmp/plstage-033550/flowh; W=/var/tmp/plstage-doors
FIN=/tmp/flags-final.json
: > $W/flags_empty.json
head -c 40 $FIN > $W/flags_truncated.json
printf '{"LITE_ADMISSION_OPEN_COUNTRY_PREFIXES": ["1767"],' > $W/flags_halfobject.json
printf '{not json' > $W/flags_malformed2.json
cp $FIN $W/flags_valid_control.json
for spec in "doors5V flags_valid_control.json" "doors5E flags_empty.json" "doors5T flags_truncated.json" "doors5H flags_halfobject.json" "doors5M flags_malformed2.json"; do
  set -- $spec
  docker ps -aq -f name=^$1$ | grep -q . && { echo "$1 exists"; exit 2; }
  docker run -d --name $1 --network plstage --cpus 1 -m 1200m --env-file $W/env_doors -v $R:/h:ro -v $W/$2:/app/data/runtime-flags.json:ro $IMG node ./node_modules/next/dist/bin/next start >/dev/null
done
for i in $(seq 1 60); do sleep 2; ok=1; for n in doors5V doors5E doors5T doors5H doors5M; do docker logs $n 2>&1 | grep -q "Ready in" || ok=0; done; [ $ok = 1 ] && break; done
n=0
for spec in "doors5V valid-final (POSITIVE control: must ADMIT)" "doors5E EMPTY file" "doors5T TRUNCATED json (40 bytes)" "doors5H HALF object (valid prefix, no closing brace)" "doors5M MALFORMED json"; do
  set -- $spec; c=$1; shift; n=$((n+1)); ph=1767555$((9000+n))01
  OUT=$(docker exec -i -e DOOR=2 -e PHONE=$ph $c sh -c 'cd /app && node -' < /tmp/zz-doors-harness.js 2>&1 | tail -1)
  echo "[$*] SYNTHETIC 1767 number, Flow v7.1 CONFIRM -> $(echo "$OUT" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('log=',d.get('admission_log'),'accounts_delta=',d.get('accounts_delta'),'attempts_delta=',d.get('attempts_delta'))" 2>/dev/null || echo "$OUT" | cut -c1-200)"
done
