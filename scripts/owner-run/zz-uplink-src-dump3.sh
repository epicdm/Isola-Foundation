#!/bin/bash
# READ-ONLY: public-turn-limits.ts head (defaults, positiveInt) and limiter body from the RUNNING container (source only).
C=$(docker ps -q -f name=uplink_uplink-app-prod -f status=running | head -1)
docker exec $C sh -c "cd /app/packages/crm/src; sed -n '1,32p;55,80p' lib/agents/public-turn-limits.ts | cut -c1-190 | cat -n" </dev/null
