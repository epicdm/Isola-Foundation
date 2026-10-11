#!/bin/bash
# host03 STAGING ONLY (plstg_* / uplinkstg_*; never a production service). Expert-concierge conversation suite setup.
#   base   : plfix fixture PL service, mock Chatwoot keeps buttons, adapter -> plfix + account tools, Uplink staging -> REAL model,
#            relay staging -> adapter actions; staging dollar envelope 35 cents (gate row = app env).
#   before : adapter rc12 + relay rc9 + agent v8 config (the production state before this work)
#   after  : adapter rc13 + relay rc10 + agent v9 config
# Inputs staged in /tmp/zzx/ by the caller. Nothing secret is printed.
set -u
D="sudo -n docker"; W=/home/epicadmin/zz-lanea-plsvc-20261009; X=/tmp/zzx
PH=${1:?phase}
wait_svc() { for i in $(seq 1 60); do s=$($D service ps $1 --filter desired-state=running --format '{{.CurrentState}}' | head -1); case "$s" in Running*) echo "$1: $s"; return 0;; esac; sleep 3; done; echo "$1: NOT RUNNING ($s)"; return 1; }
app() { $D ps -q -f name=uplinkstg_uplink-app | head -1; }
agent_apply() {   # $1 config json, $2 enabled list, $3 note
  local C; C=$(app)
  $D cp $X/uplink_agent_apply.ts $C:/app/packages/crm/zz_apply.ts >/dev/null && $D cp $1 $C:/tmp/zz_cfg.json >/dev/null
  ST=$(sudo -n python3 -c "import json;d=json.load(open('$W/uplink/state/state.json'));print(d['orgId'],d['agentId'])"); set -- $ST "$2" "$3"
  # same environment mechanism the staging app's own start command uses (sourced in-process, never printed)
  $D exec -e ORG=$1 -e AGENT=$2 -e CONFIG=/tmp/zz_cfg.json -e ENABLED=$3 -e NOTE="$4" -e MODE=${APPLY_MODE:-apply} $C sh -c 'set -a; . /run/secrets/app_env; set +a; cd /app/packages/crm && npx tsx zz_apply.ts' 2>&1 | grep -E '^agent|^BEFORE|^PLAN|^updateAgentBlueprint|^READBACK|ERROR|DRY'
  $D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json
}
if [ "$PH" = base ]; then
  mkdir -p $W/plfix && cp $X/plfix.mjs $W/plfix/plfix.mjs
  $D service inspect plstg_plfix >/dev/null 2>&1 || $D service create --detach --name plstg_plfix --network name=plstg_net,alias=plfix \
    --mount type=bind,src=$W/plfix,dst=/plfix,readonly node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 node /plfix/plfix.mjs >/dev/null
  wait_svc plstg_plfix
  cp -p $W/mock/mock-ext.mjs $W/mock/mock-ext.mjs.pre-rc13 2>/dev/null; cp $X/mock-ext-rc13.mjs $W/mock/mock-ext.mjs
  $D service update --detach --force plstg_mock-ext >/dev/null; wait_svc plstg_mock-ext
  $D service update --detach --env-add PL_BASE_URL=http://plfix:3005 --env-add PL_ACCOUNT_TOOLS=1 --env-rm STAGING_DIRECT_OFFER plstg_adapter >/dev/null; wait_svc plstg_adapter
  $D service update --detach --host-rm "api.deepseek.com:10.77.0.123" --env-add PUBLIC_PILOT_BUDGET_CENTS=35 uplinkstg_uplink-app >/dev/null; wait_svc uplinkstg_uplink-app
  $D service update --detach --secret-add source=plstg_adapter_bearer_v1,target=adapter_bearer --secret-add source=plstg_tls_ca_v2,target=tls_ca \
    --env-add PL_ADAPTER_URL=https://adapter:9100 --env-add PL_ADAPTER_BEARER_FILE=/run/secrets/adapter_bearer --env-add NODE_EXTRA_CA_CERTS=/run/secrets/tls_ca uplinkstg_relay >/dev/null
  $D service inspect uplinkstg_uplink-app --format 'app hosts now: {{json .Spec.TaskTemplate.ContainerSpec.Hosts}}'
fi
if [ "$PH" = before ] || [ "$PH" = after ]; then
  if [ "$PH" = before ]; then AD=$X/adapter-rc12.mjs; RIMG=sf-relay-ctx:rc9-actions-cbf1d10c; CFG=$X/agent_v8_config.json; else AD=$X/adapter-rc13.mjs; RIMG=sf-relay-ctx:rc10-facts-cbf1d10c; CFG=$X/agent_v9_config.json; fi
  [ -f $W/adapter/pl-action-adapter.mjs.pre-expert ] || cp -p $W/adapter/pl-action-adapter.mjs $W/adapter/pl-action-adapter.mjs.pre-expert
  cp $AD $W/adapter/pl-action-adapter.mjs; $D service update --detach --force plstg_adapter >/dev/null; wait_svc plstg_adapter
  $D service update --detach --no-resolve-image --image $RIMG uplinkstg_relay >/dev/null; wait_svc uplinkstg_relay
  sleep 6
  C=$($D ps -q -f name=plstg_adapter | head -1); echo "adapter sha: $($D exec $C sha256sum /adapter/pl-action-adapter.mjs | cut -c1-8)"
  R=$($D ps -q -f name=uplinkstg_relay | head -1); $D logs --since 1m $R 2>&1 | grep boot | tail -1
  agent_apply $CFG "pl_offer,pl_present_offer,pl_provision,pl_status,pl_next_step,pl_balance,pl_recent_calls,pl_journey,pl_guide" "expert suite $PH config"
fi
