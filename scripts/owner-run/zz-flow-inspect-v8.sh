#!/bin/bash
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker exec -i $R node - < /tmp/zz-flow-inspect-v8.js 2>&1 | cut -c1-300
