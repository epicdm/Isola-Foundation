#!/bin/bash
# host03 STAGING one-shot runner (rc16g). usage: h5_oneshot.sh <script.mjs in /home/epicadmin/zz-lanea-rc16-20261011/h> [image]
# Runs the script on plstg_net as a uniquely named, self-removing service with the staging secrets mounted READ-ONLY at fixed paths
# (read in-process by the script, never printed): plenv (staging app env), plkey (PL HMAC key), ctxkey (relay context key), bearer.
D="sudo -n docker"; H=/home/epicadmin/zz-lanea-rc16-20261011/h
SCRIPT=${1:?script}; IMG=${2:-plsvc-staging-synthetic:rc16g}
N=zzl_rc16g_$(date +%H%M%S)
EXTRA=""
# non-secret adapter identity values for relay-context / assertion minting (read from the shared staging adapter's spec; names listed, values never printed)
AE=$($D service inspect plstg_adapter --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}')
getv() { printf '%s
' "$AE" | grep -m1 "^$1=" | cut -d= -f2-; }
export ADAPTER_ENV_RELAY_KID=$(getv RELAY_CONTEXT_KEY_ID) ADAPTER_ENV_ACCOUNT=$(getv CHATWOOT_ACCOUNT_ID) ADAPTER_ENV_INBOX=$(getv CHATWOOT_INBOX_ID) ADAPTER_ENV_WORKSPACE=$(getv EXPECTED_WORKSPACE_ID) ADAPTER_ENV_AGENT=$(getv EXPECTED_AGENT_ID) ADAPTER_ENV_SLUG=$(getv EXPECTED_AGENT_SLUG) ADAPTER_ENV_PL_KID=$(getv PL_KID)
unset AE
for v in PHASES ADAPTER_DOWN ADAPTER_ENV_RELAY_KID ADAPTER_ENV_ACCOUNT ADAPTER_ENV_INBOX ADAPTER_ENV_WORKSPACE ADAPTER_ENV_AGENT ADAPTER_ENV_SLUG ADAPTER_ENV_PL_KID USE_WA; do [ -n "${!v:-}" ] && EXTRA="$EXTRA --env $v=${!v}"; done
$D service create --detach --name $N --restart-condition none --network plstg_net \
  --secret source=plstg_app_env_v3,target=plenv --secret source=plstg_pl_hmac_key_v2,target=plkey \
  --secret source=plstg_relay_ctx_key_v1,target=ctxkey --secret source=plstg_adapter_bearer_v1,target=bearer \
  $EXTRA --mount type=bind,src=$H,dst=/app/zzh,readonly \
  --no-resolve-image --entrypoint node $IMG /app/zzh/$SCRIPT >/dev/null || { echo "CREATE FAILED"; exit 1; }
for i in $(seq 1 300); do st=$($D service ps $N --format '{{.CurrentState}}' | head -1); case "$st" in Complete*|Failed*|Rejected*|Shutdown*) break;; esac; sleep 2; done
echo "task: $st"
$D service logs $N --no-task-ids --raw 2>&1
$D service rm $N >/dev/null 2>&1
