#!/bin/bash
D="docker"; X=/tmp/zzx
ORG=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8; AGENT=28a55c69-ef04-416f-9c91-7d72e9e21345
C=$($D ps -q -f name=uplink_uplink-app-prod | head -1)
$D cp $X/uplink_agent_apply.ts $C:/app/packages/crm/zz_apply.ts >/dev/null && $D cp $X/agent_v17_config.json $C:/tmp/zz_cfg.json >/dev/null
run() { $D exec -e ORG=$ORG -e AGENT=$AGENT -e CONFIG=/tmp/zz_cfg.json -e ENABLED="$1" -e NOTE="v17: incoming calls work and are free with a positive balance; 60 trial minutes are outgoing Dominica; paid plans/top-ups not available yet (owner via PM 2026-10-13)" -e MODE=$2 $C sh -c 'cd /app/packages/crm && npx tsx zz_apply.ts' 2>&1 | cut -c1-400; }
OUT=$(run "pl_journey" dry); echo "$OUT"
EN=$(echo "$OUT" | sed -n 's/^BEFORE enabled=\[\(.*\)\] .*/\1/p' | tr -d '"')
echo "keeping enabled: $EN"
[ -n "$EN" ] || { echo "ABORT: could not read current enabled set"; $D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json; exit 2; }
[ "$1" = apply ] && run "$EN" apply
$D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json
