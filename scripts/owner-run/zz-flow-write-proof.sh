#!/bin/bash
# Run the Flow write-path proof inside the relay container (token read in-process). Needs /tmp/zz-flow-write-proof.js staged.
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker exec -i $R node - < /tmp/zz-flow-write-proof.js 2>&1 | cut -c1-420
