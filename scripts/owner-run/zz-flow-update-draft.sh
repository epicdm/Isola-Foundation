#!/bin/bash
# usage: FLOWID=<draft id> JSONFILE=/tmp/xxx.json bash zz-flow-update-draft.sh   (needs /tmp/zz-flow-update-draft.js staged)
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker cp ${JSONFILE} $R:/tmp/flow-update.json >/dev/null
docker exec -i -e FLOW_ID=${FLOWID} $R node - < /tmp/zz-flow-update-draft.js 2>&1 | cut -c1-420
docker cp $R:/tmp/flow-update-preview.url /tmp/flow-update-preview.url.root >/dev/null 2>&1 && chmod 644 /tmp/flow-update-preview.url.root && echo "preview url staged (length $(wc -c < /tmp/flow-update-preview.url.root))"
docker exec $R rm -f /tmp/flow-update.json /tmp/flow-update-preview.url </dev/null
