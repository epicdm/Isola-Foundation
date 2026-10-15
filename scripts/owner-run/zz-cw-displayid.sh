#!/bin/bash
CW=$(docker ps -q -f name=uplink_chatwoot-db | head -1)
docker exec -i $CW psql -U postgres -d isola -X -At -F ' | ' -c "select id, display_id, account_id, inbox_id, status from conversations where id=599 or display_id=599 or display_id=521" </dev/null
