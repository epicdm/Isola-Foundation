#!/bin/bash
# READ-ONLY: print selected line ranges of the deployed overlay source from the RUNNING container (source code only, no env values).
C=$(docker ps -q -f name=uplink_uplink-app-prod -f status=running | head -1)
sl() { echo "##### $1 [$2-$3]"; docker exec $C sh -c "cd /app/packages/crm/src; sed -n '$2,$3p' '$1' | cat -n | sed 's/^ *\([0-9]*\)/\1/' " </dev/null | awk -v off=$(( $2 - 1 )) '{n=$1+off; $1=""; print n ":" $0}'; }
sl lib/agents/public-pilot-controls.ts 1 60
sl lib/agents/public-pilot-controls.ts 195 227
sl lib/agents/public-turn-spend.ts 90 215
sl "app/api/v1/public/agent/[slug]/turn/route.ts" 200 216
sl "app/api/v1/public/agent/[slug]/turn/route.ts" 380 430
