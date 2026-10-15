#!/bin/bash
# ISOLATED STAGING: run the synthetic new-customer journey (zz-sim-newuser-v8.js) against the DEPLOYED plsvc image on the private plstage
# network: staging DB flow_harness (pgstage), Magnus = fakemagnus3 stub (refuses every write), NO Meta token (sends cannot leave the box).
# Run on host04 as root with zz-sim-newuser-v8.js in /tmp. Leaves sim8 running for inspection; nothing here touches production services.
set -u
IMG=localhost:5000/pl/plsvc@sha256:624d69167f55246ea0e25403ac774cc923ac3ab73372dc8e369b63df4db295f0
R=/var/tmp/plstage-033550/flowh; W=/var/tmp/plstage-doors; S=/var/tmp/plstage-sim8; mkdir -p $S
[ -f $R/env_secret ] && [ -f $R/pub.pem ] && [ -f $W/flags_open.json ] && [ -f $W/fakemagnus.js ] || { echo "staging inputs missing"; exit 3; }
docker ps -aq -f name=^sim8$ | grep -q . && { echo "sim8 exists - inspect or remove it first"; exit 2; }
docker start pgstage fakemagnus3 >/dev/null
# env: staging env (keeps PREVIEW_SIMULATE_PROVISIONING) + the production Flow ids / sender id (public ids) + activation on; NO Meta token
grep -vE '^(META_WA_TOKEN|WHATSAPP_TOKEN|META_SYSTEM_TOKEN)=' $R/env_secret > $S/env
printf 'PL_SIGNUP_FLOW_ID=1028745810223586\nPL_SIGNUP_FLOW_ID_V8=1650155129897917\nPL_FLOW_SENDER_PHONE_ID=1023804347491554\nPL_CONCIERGE_PNID_ALLOWLIST=1023804347491554\nLITE_ACTIVATION_ENABLED=true\nMAGNUS_URL=http://fakemagnus3:8080\nMAGNUS_API_KEY=staging-stub\nMAGNUS_API_SECRET=staging-stub\n' >> $S/env
docker run -d --name sim8 --network plstage --cpus 1 -m 1536m --env-file $S/env -v $R:/h:ro -v $W/flags_open.json:/app/data/runtime-flags.json:ro $IMG node ./node_modules/next/dist/bin/next start >/dev/null
for i in $(seq 1 60); do sleep 2; docker logs sim8 2>&1 | grep -q "Ready in" && break; done
echo "sim8: $(docker ps --format '{{.Status}}' -f name=^sim8$) image=$(docker inspect sim8 --format '{{.Image}}' | cut -c1-19)"
docker exec -i sim8 sh -c 'cd /app && node -' < /tmp/zz-sim-newuser-v8.js 2>&1 | grep -E '^(PASS|FAIL|NOTE|TALLY)' | cut -c1-700
echo "--- sim8 log (provisioning / gate lines)"; docker logs sim8 2>&1 | grep -E 'SIMULATED|flows/signup-v8|PL button|sendPlCtaButton|gate\]|dispatch failed' | tail -14 | cut -c1-220
