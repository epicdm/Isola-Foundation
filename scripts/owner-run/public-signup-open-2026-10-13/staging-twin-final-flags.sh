#!/bin/bash
IMG=localhost:5000/pl/plsvc@sha256:5acad2e83272754745bf088421fba3e2bf1db390f87cd3259f4a5423aa600115
R=/var/tmp/plstage-033550/flowh; W=/var/tmp/plstage-doors
ls /tmp/zz-doors-harness.js $W/env_doors >/dev/null 2>&1 || { echo "harness/env missing"; exit 3; }
echo "fakemagnus3: $(docker ps --format '{{.Status}}' -f name=^fakemagnus3$)"
cp /tmp/flags-final.json $W/flags_final_bytes.json; echo "twin flags sha: $(sha256sum $W/flags_final_bytes.json | cut -c1-16)"
docker ps -aq -f name=^doors4F$ | grep -q . && { echo "doors4F exists"; exit 2; }
docker run -d --name doors4F --network plstage --cpus 1 -m 1536m --env-file $W/env_doors -v $R:/h:ro -v $W/flags_final_bytes.json:/app/data/runtime-flags.json:ro $IMG node ./node_modules/next/dist/bin/next start >/dev/null
for i in $(seq 1 45); do sleep 2; docker logs doors4F 2>&1 | grep -q "Ready in" && break; done
echo "doors4F: $(docker ps --format '{{.Status}}' -f name=^doors4F$)"
for spec in "1 17675559101 SYNTHETIC 1767 number, door 1 legacy Flow WELCOME" "2 17675559201 SYNTHETIC 1767 number, door 2 Flow v7.1 CONFIRM" "2 14155559301 SYNTHETIC NON-1767 number, door 2 Flow v7.1 CONFIRM (negative control)"; do
  set -- $spec; d=$1; ph=$2; shift 2
  OUT=$(docker exec -i -e DOOR=$d -e PHONE=$ph doors4F sh -c 'cd /app && node -' < /tmp/zz-doors-harness.js 2>&1 | tail -1)
  echo "[$*] -> $OUT" | cut -c1-420
done
