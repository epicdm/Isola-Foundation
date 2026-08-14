#!/usr/bin/env bash
# Weekday receivables run for the EPIC Staff Operations Coordinator.
#
# Invoked by isola-ar-run.timer at 11:00 UTC Mon-Fri = 07:00 America/Dominica, the
# emptiest hour in 5.5 days of Ollama request logs (0 requests observed in that hour).
# host03 is Etc/UTC, so the timer is expressed in UTC deliberately.
#
# The container is resolved by filter, not by name: it is a Swarm task and its name
# changes on every redeploy.
set -euo pipefail

COMPANY_ID="3ed3869b-463c-4876-8e16-ddc058f06cd9"
AGENT_ID="2b4cf82a-00d5-496b-877e-b5bc9201d52c"
INSTR="/paperclip/instances/default/companies/${COMPANY_ID}/agents/${AGENT_ID}/instructions"

CID=$(docker ps -q --filter "name=isola_ai" --filter "health=healthy" | head -1)
[ -z "$CID" ] && CID=$(docker ps -q --filter "name=isola_ai" | head -1)
if [ -z "$CID" ]; then
  echo "isola_ai container not running; nothing to do" >&2
  exit 0
fi

exec docker exec -u node \
  -e AGENT_INSTRUCTIONS_DIR="$INSTR" \
  -e PAPERCLIP_COMPANY_ID="$COMPANY_ID" \
  -e PAPERCLIP_AGENT_ID="$AGENT_ID" \
  "$CID" node /paperclip/bin/ar-run.js
