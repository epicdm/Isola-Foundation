#!/bin/bash
# host03 STAGING: run one .mjs from /tmp/zzx as a one-shot Swarm task inside plstg_net (same secrets/CA as the e2e harness; nothing printed).
# usage: run_in_plstg.sh <script.mjs> [args...]
D="sudo -n docker"; W=/home/epicadmin/zz-lanea-plsvc-20261009; H=$W/uplink/expert
SCRIPT=$1; shift
N=plstg_x_$(date +%H%M%S)
mkdir -p $H && cp /tmp/zzx/$SCRIPT $H/$SCRIPT
$D service create --detach --name $N --restart-condition none --network plstg_net \
  --secret source=uplinkstg_relay_bot_secret_v1,target=bot_secret --secret source=uplinkstg_app_env_v1,target=uplink_env \
  --secret source=plstg_tls_ca_v2,target=tls_ca --env NODE_EXTRA_CA_CERTS=/run/secrets/tls_ca --env ONLY=${ONLY:-} --env CONV_OFFSET=${CONV_OFFSET:-0} \
  --mount type=bind,src=$H,dst=/h,readonly \
  plsvc-staging-synthetic:d736dbf3 node /h/$SCRIPT "$@" >/dev/null
for i in $(seq 1 ${WAIT_ITERS:-450}); do st=$($D service ps $N --format '{{.CurrentState}}' | head -1); case "$st" in Complete*|Failed*|Rejected*|Shutdown*) break;; esac; sleep 2; done
echo "task: $st"
$D service logs $N --no-task-ids --raw 2>&1
$D service rm $N >/dev/null 2>&1
