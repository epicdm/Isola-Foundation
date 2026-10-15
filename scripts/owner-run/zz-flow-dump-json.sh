#!/bin/bash
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker exec -i $R node - < /tmp/zz-flow-dump-json.js 2>/dev/null
