#!/bin/bash
# READ-ONLY: (1) does the plsvc's configured PL_SIGNUP_FLOW_ID equal the Flow id we inspect (boolean only); (2) Meta's status of that Flow via the relay token in-process.
PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
ID=$(docker exec $PL sh -c "tr '\\0' '\\n' </proc/1/environ | grep '^PL_SIGNUP_FLOW_ID=' | cut -d= -f2" </dev/null)
echo "plsvc PL_SIGNUP_FLOW_ID equals 1028745810223586: $([ "$ID" = "1028745810223586" ] && echo yes || echo NO) (len ${#ID})"
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker exec -i -e FLOW_ID="$ID" $R node - < /tmp/zz-flow-status.js 2>&1 | cut -c1-300
