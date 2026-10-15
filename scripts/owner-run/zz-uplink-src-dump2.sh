#!/bin/bash
# READ-ONLY: the rate-limit resolver and spend reservation/ceiling lines in the RUNNING container (source only).
C=$(docker ps -q -f name=uplink_uplink-app-prod -f status=running | head -1)
docker exec $C sh -c 'cd /app/packages/crm/src; grep -rn "resolvePublicTurnLimits\|PUBLIC_TURN_" --include=*.ts lib app | grep -v "^lib/.*test" | cut -c1-200 | head -20' </dev/null
F=$(docker exec $C sh -c 'cd /app/packages/crm/src; grep -rl "export function resolvePublicTurnLimits" lib app 2>/dev/null | head -1' </dev/null)
echo "FILE: $F"
docker exec $C sh -c "cd /app/packages/crm/src; grep -n 'resolvePublicTurnLimits' -A 28 '$F' | head -60" </dev/null
echo "##### public-turn-spend.ts 96-186"
docker exec $C sh -c "cd /app/packages/crm/src; sed -n '96,186p' lib/agents/public-turn-spend.ts | cut -c1-200 | awk '{printf \"%d:%s\n\", NR+95, \$0}'" </dev/null
