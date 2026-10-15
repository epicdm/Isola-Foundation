#!/bin/bash
# READ-ONLY: run the Flow-JSON summariser inside the relay container (uses the relay's own presence token in-process; the token is never printed).
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker cp /tmp/flow-json.js $R:/tmp/flow-json.js >/dev/null
docker exec $R node /tmp/flow-json.js </dev/null 2>&1 | cut -c1-260
docker exec $R rm -f /tmp/flow-json.js </dev/null
