#!/bin/bash
# usage: webfaq-apply.sh dry|apply|rollback
MODE=${1:-dry}
UP=$(docker ps -q -f name=uplink_uplink-db-prod | head -1)
cat > /tmp/wf-ids.sql <<'EOF'
\pset format unaligned
\pset tuples_only on
select id || ' ' || org_id from agents where id::text like 'a5e7235d%';
EOF
docker cp /tmp/wf-ids.sql $UP:/tmp/wf-ids.sql
IDS=$(docker exec $UP sh -c 'psql -U "$POSTGRES_USER" -d uplink -X -q -f /tmp/wf-ids.sql' | tail -1)
AGENT_FULL=${IDS% *}; ORG=${IDS#* }
echo "agent $AGENT_FULL org $ORG"
A=$(docker ps -q -f name=uplink_uplink-app-prod | head -1)
docker cp /tmp/webchat_skill_https.ts $A:/app/packages/crm/zz_webskill.ts >/dev/null
EXTRA=""; [ "$MODE" = "rollback" ] && EXTRA="-e ROLLBACK=1"
M=dry; [ "$MODE" != "dry" ] && M=apply
docker exec -e ORG=$ORG -e AGENT=$AGENT_FULL -e MODE=$M $EXTRA $A sh -c 'cd /app/packages/crm && npx tsx zz_webskill.ts' 2>&1 | grep -v "npm notice" | cut -c1-400
docker exec $A rm -f /app/packages/crm/zz_webskill.ts
