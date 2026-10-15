#!/bin/bash
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
docker exec -i -w /app $P node - < /tmp/zz-did-pool-read.js 2>&1 | cut -c1-300
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
echo "admission floor / recent facts in the log (detail keys):"; docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "select detail::text from lite_admission_log where detail is not null order by created_at desc limit 1" </dev/null | cut -c1-300
