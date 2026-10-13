#!/bin/bash
# Apply agent v18 (or roll back with CFG=agent_v17_config.json) through the existing update path (updateAgentBlueprint). usage: apply18.sh [CFG file name in /tmp/zzx] [NOTE]
CFG=${1:-agent_v18_config.json}; NOTE=${2:-"v18: trial minutes always stated as outgoing Dominica; incoming never volunteered, sure/unsure wording when asked (S1 finding, PM-confirmed 2026-10-13)"}
D="docker"; X=/tmp/zzx
ORG=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8; AGENT=28a55c69-ef04-416f-9c91-7d72e9e21345
C=$($D ps -q -f name=uplink_uplink-app-prod | head -1)
$D cp $X/uplink_agent_apply.ts $C:/app/packages/crm/zz_apply.ts >/dev/null && $D cp $X/$CFG $C:/tmp/zz_cfg.json >/dev/null
run() { $D exec -e ORG=$ORG -e AGENT=$AGENT -e CONFIG=/tmp/zz_cfg.json -e ENABLED="$1" -e NOTE="$NOTE" -e MODE=$2 $C sh -c 'cd /app/packages/crm && npx tsx zz_apply.ts' 2>&1 | grep -v "npm notice" | cut -c1-400; }
OUT=$(run "pl_journey" dry); echo "$OUT"
EN=$(echo "$OUT" | sed -n 's/^BEFORE enabled=\[\(.*\)\] .*/\1/p' | tr -d '"')
[ -n "$EN" ] || { echo "ABORT: could not read current enabled set"; $D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json; exit 2; }
echo "[$(date -u +%FT%TZ)] applying with the enabled tool set unchanged"
run "$EN" apply
$D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json
