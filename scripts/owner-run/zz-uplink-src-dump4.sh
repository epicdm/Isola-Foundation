#!/bin/bash
# READ-ONLY: exact call sites (file:line) of the pilot request-size ceiling and the reservation math in the RUNNING container source.
C=$(docker ps -q -f name=uplink_uplink-app-prod -f status=running | head -1)
docker exec $C sh -c 'cd /app/packages/crm/src; grep -rn -E "isPublicPilotRequestWithinInputLimit|maximumPublicTurnReservationMicroUsd|MAX_VERIFIED_RELAY_INPUT_BYTES_PER_REQUEST|MAX_PUBLIC_PILOT_INPUT_BYTES_PER_REQUEST|maxSerializedRequestBytes|requestBytesCeiling|settlePublicTurnSpend|metered" app/api/v1/public/agent lib/agents/runtime.ts lib/agents/public-turn-spend.ts lib/agents/public-pilot-controls.ts | cut -c1-210' </dev/null
