#!/bin/bash
# host03 STAGING one-shot: run flowdrive.mjs on plstg_net with the staging web env secret mounted (read in-process, never printed).
D="sudo -n docker"; H=/home/epicadmin/zz-lanea-rc16-20261011/h
N=zzl_rc16_drive_$(date +%H%M%S)
cp /tmp/zzrc16/flowdrive.mjs $H/flowdrive.mjs 2>/dev/null; chmod 0644 $H/flowdrive.mjs
$D service create --detach --name $N --restart-condition none --network plstg_net \
  --secret source=plstg_app_env_v3,target=plenv --env USE_WA=17675550159 --mount type=bind,src=$H,dst=/app/zzh,readonly \
  --entrypoint node plsvc-staging-synthetic:rc16-8600c15c /app/zzh/flowdrive.mjs >/dev/null
for i in $(seq 1 150); do st=$($D service ps $N --format '{{.CurrentState}}' | head -1); case "$st" in Complete*|Failed*|Rejected*|Shutdown*) break;; esac; sleep 2; done
echo "task: $st"
$D service logs $N --no-task-ids --raw 2>&1
$D service rm $N >/dev/null 2>&1
echo "--- plstg_web log lines for the store button"
$D service logs --since 10m plstg_zzrc16_web 2>&1 | grep -E "store-button|PL store button|sendPlStoreButton|flows/signup" | tail -40 | sed -E 's/wa=\*\*\*[0-9]{4}/wa=***NNNN/' | cut -c1-220
