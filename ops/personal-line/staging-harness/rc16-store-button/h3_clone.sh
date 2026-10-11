#!/bin/bash
# host03 STAGING ONLY: dedicated rc16 web (plstg_zzrc16_web, alias web-rc16) - a clone of plstg_web's runtime (same image recipe, same
# staging env secret, same staging DB, same data mount) PLUS the store-button proof scaffolding. plstg_web itself is left untouched.
set -u
D="sudo -n docker"; H=/home/epicadmin/zz-lanea-rc16-20261011/h; S=plstg_zzrc16_web; IMG=${IMG:-plsvc-staging-synthetic:rc16f-bb85db5c}
# the metamock VIP measured at creation (10.77.0.16/24); refuse if it moved, the mapping below is literal
[ "$($D service inspect plstg_zzrc16_metamock --format '{{range .Endpoint.VirtualIPs}}{{.Addr}}{{end}}')" = "10.77.0.16/24" ] || { echo "metamock VIP changed - stop"; exit 1; }
$D service inspect $S >/dev/null 2>&1 && { echo "$S exists"; exit 1; }
FKB64=$(base64 -w0 < $H/flowkey/flow_private.pem); DUMMY=$(openssl rand -hex 24)
$D service create --detach --name $S --network name=plstg_net,alias=web-rc16 --restart-condition any \
  --secret source=plstg_app_env_v3,target=/app/.env,mode=0400 \
  --mount type=bind,src=/home/epicadmin/zz-lanea-plsvc-20261009/data,dst=/app/data,readonly \
  --mount type=bind,src=$H,dst=/zzrc16,readonly --host graph.facebook.com:10.77.0.16 \
  --env LITE_ACTIVATION_ENABLED=true --env 'LITE_ACTIVATION_ALLOWLIST=*' \
  --env ISOLA_RUNTIME_ENV=staging --env STAGING_WA_ALLOWLIST_FILE=/zzrc16/allow.json \
  --env PL_FLOW_SENDER_PHONE_ID=100000000000099 --env WHATSAPP_TOKEN=$DUMMY \
  --env NODE_EXTRA_CA_CERTS=/zzrc16/tls/ca.pem --env FLOW_PRIVATE_KEY_B64=$FKB64 \
  --no-resolve-image $IMG >/dev/null || { echo "CREATE FAILED"; exit 1; }
unset FKB64 DUMMY
for i in $(seq 1 60); do s=$($D service ps $S --filter desired-state=running --format '{{.CurrentState}} {{.Image}}' | head -1); case "$s" in Running*) break;; esac; sleep 3; done
echo "$S: $s"
for i in $(seq 1 30); do $D service logs $S 2>&1 | grep -q "Ready in" && break; sleep 2; done
$D service logs $S 2>&1 | grep -E "Ready in|rror" | tail -3 | cut -c1-200
C=$($D ps -q -f name=$S | head -1)
echo "task image id: $($D inspect $C --format '{{.Image}}' | cut -c1-19)"
$D exec $C node -e "require('dns').lookup('graph.facebook.com',{all:true},(e,a)=>console.log('graph.facebook.com ->',e?e.code:JSON.stringify(a)))"
