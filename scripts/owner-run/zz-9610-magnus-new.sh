#!/bin/bash
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
docker exec -i -w /app $P node - < /tmp/zz-9610-magnus-new.js 2>&1 | cut -c1-300
