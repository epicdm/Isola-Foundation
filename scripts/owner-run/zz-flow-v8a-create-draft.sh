#!/bin/bash
# Create the config-only v8-A DRAFT Flow (never published). Needs /tmp/flow-v8a.json and /tmp/zz-flow-v8-create-draft.js staged on host04. Relay container, token in-process.
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker cp /tmp/flow-v8a.json $R:/tmp/flow-v8a.json >/dev/null
docker exec -i -e FLOW_FILE=/tmp/flow-v8a.json -e PREVIEW_FILE=/tmp/flow-v8a-preview.url -e "FLOW_NAME=Isola Personal Line Onboarding v8-A config-only (2026-10-14)" $R node - < /tmp/zz-flow-v8-create-draft.js 2>&1 | cut -c1-420
docker cp $R:/tmp/flow-v8a-preview.url /tmp/flow-v8a-preview.url.root >/dev/null 2>&1 && chmod 644 /tmp/flow-v8a-preview.url.root && echo "preview url staged (length $(wc -c < /tmp/flow-v8a-preview.url.root))"
docker exec $R rm -f /tmp/flow-v8a.json /tmp/flow-v8a-preview.url </dev/null
