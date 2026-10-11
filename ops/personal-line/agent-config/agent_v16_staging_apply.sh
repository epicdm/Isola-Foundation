#!/bin/bash
# host03 STAGING ONLY: apply agent config v14 (personality/formatting) to the STAGING agent, then run 3 real-model scenarios
# (S1 new prospect, S3 connected first call, S15 calling app) on synthetic plfix identities. Nothing secret printed.
set -u
D="sudo -n docker"; W=/home/epicadmin/zz-lanea-plsvc-20261009; X=/tmp/zzx
C=$($D ps -q -f name=uplinkstg_uplink-app | head -1)
$D cp $X/uplink_agent_apply.ts $C:/app/packages/crm/zz_apply.ts >/dev/null && $D cp $X/agent_v16_config.json $C:/tmp/zz_cfg.json >/dev/null
ST=$(sudo -n python3 -c "import json;d=json.load(open('$W/uplink/state/state.json'));print(d['orgId'],d['agentId'])"); set -- $ST
$D exec -e ORG=$1 -e AGENT=$2 -e CONFIG=/tmp/zz_cfg.json -e ENABLED="pl_offer,pl_present_offer,pl_provision,pl_status,pl_next_step,pl_balance,pl_recent_calls,pl_journey,pl_guide" -e NOTE="v16 launch-scope wording (outgoing calling offer)" -e MODE=${MODE:-dry} $C sh -c 'set -a; . /run/secrets/app_env; set +a; cd /app/packages/crm && npx tsx zz_apply.ts' 2>&1 | grep -E '^agent|^PLAN|^updateAgentBlueprint|^READBACK|ERROR' | cut -c1-200
$D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json
