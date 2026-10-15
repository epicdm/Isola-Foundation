#!/bin/bash
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker exec -i -e FLOWS=3134714280060947,1063932616548574 $R node - < /tmp/zz-flow-dump-two.js 2>/dev/null > /tmp/flows-two.json
ls -l /tmp/flows-two.json | awk '{print $5}'
