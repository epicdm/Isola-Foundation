#!/bin/bash
# Apply agent 28a55c69 v19 (or roll back: CFG=agent_v18_config.json) through the existing update path (updateAgentBlueprint). Run on host04 as root with the files in /tmp/zzx.
# usage: apply-agent-v19-or-rollback.sh [CFG file in /tmp/zzx] [NOTE]
CFG=${1:-agent_v19_config.json}; NOTE=${2:-"v19: always point the customer to Cloud Softphone with the verified store links; sign up first, then download, then open (walkthrough defect 4, 2026-10-13)"}
X=/tmp/zzx; ORG=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8; AGENT=28a55c69-ef04-416f-9c91-7d72e9e21345
C=$(docker ps -q -f name=uplink_uplink-app-prod | head -1)
docker cp $X/uplink_agent_apply.ts $C:/app/packages/crm/zz_apply.ts >/dev/null && docker cp $X/$CFG $C:/tmp/zz_cfg.json >/dev/null
run() { docker exec -e ORG=$ORG -e AGENT=$AGENT -e CONFIG=/tmp/zz_cfg.json -e NOTE="$NOTE" -e MODE=$1 $C sh -c 'cd /app/packages/crm && npx tsx zz_apply.ts' 2>&1 | grep -v "npm notice" | cut -c1-420; }
echo "[$(date -u +%FT%TZ)] DRY"; run dry
if [ "${APPLY:-0}" = "1" ]; then echo "[$(date -u +%FT%TZ)] APPLY"; run apply; else echo "(set APPLY=1 to write)"; fi
docker exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json
