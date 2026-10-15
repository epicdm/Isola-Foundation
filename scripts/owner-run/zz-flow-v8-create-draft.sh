#!/bin/bash
# Needs /tmp/flow-v8.json and /tmp/zz-flow-v8-create-draft.js staged on host04. Runs in the relay container (token in-process).
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker cp /tmp/flow-v8.json $R:/tmp/flow-v8.json >/dev/null
docker exec -i $R node - < /tmp/zz-flow-v8-create-draft.js 2>&1 | cut -c1-420
docker cp $R:/tmp/flow-v8-preview.url /root/flow-v8-preview.url >/dev/null 2>&1 && chmod 600 /root/flow-v8-preview.url && echo "preview url stored on host04 root (0600), length $(wc -c < /root/flow-v8-preview.url)"
docker exec $R rm -f /tmp/flow-v8.json /tmp/flow-v8-preview.url </dev/null
