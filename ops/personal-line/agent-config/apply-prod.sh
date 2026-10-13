#!/bin/bash
# PRODUCTION agent config apply v14 (personality + WhatsApp formatting; staging-tested 2026-10-11 S1/S3/S15).
# Same path as v12: Uplink's own updateAgentBlueprint inside uplink_uplink-app-prod (version bump + agent_versions row; no eval run).
# The prod enabled-tool set is read from a DRY run and passed back UNCHANGED. Rollback = re-apply agent_v13_config.json the same way.
set -u
D="sudo -n docker"; X=/tmp/zzx
ORG=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8; AGENT=28a55c69-ef04-416f-9c91-7d72e9e21345
C=$($D ps -q -f name=uplink_uplink-app-prod | head -1)
$D cp $X/uplink_agent_apply.ts $C:/app/packages/crm/zz_apply.ts >/dev/null && $D cp $X/agent_v15_config.json $C:/tmp/zz_cfg.json >/dev/null
run() { $D exec -e ORG=$ORG -e AGENT=$AGENT -e CONFIG=/tmp/zz_cfg.json -e ENABLED="$1" -e NOTE="v15 outbound-only launch scope: no incoming-call claims (PM 2026-10-11)" -e MODE=$2 $C sh -c 'cd /app/packages/crm && npx tsx zz_apply.ts' 2>&1 | grep -E '^agent|^BEFORE|^PLAN|^updateAgentBlueprint|^READBACK|ERROR|DRY' | cut -c1-260; }
OUT=$(run "pl_journey" dry)
echo "$OUT"
EN=$(echo "$OUT" | sed -n 's/^BEFORE enabled=\[\(.*\)\] .*/\1/p' | tr -d '"')
echo "keeping enabled: $EN"
[ -n "$EN" ] || { echo "ABORT: could not read current enabled set"; $D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json; exit 2; }
run "$EN" apply
$D exec $C rm -f /app/packages/crm/zz_apply.ts /tmp/zz_cfg.json
