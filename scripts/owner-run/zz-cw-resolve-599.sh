#!/bin/bash
R=$(docker ps -q -f name=uplink_sf-relay-pl-prod | head -1)
docker exec -i $R node - < /tmp/zz-cw-resolve-599.js 2>&1 | cut -c1-260
CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1)
echo "db read-back: $(docker exec -i $CW psql -U postgres -d isola -X -At -c "select 'conv 599 (display 521) status='||status||' (0 open,1 resolved,2 pending) assignee='||coalesce(assignee_id::text,'-') from conversations where id=599" </dev/null)"
