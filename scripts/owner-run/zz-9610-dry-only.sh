#!/bin/bash
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
ls -l /tmp/zz-fx-reset.js
docker exec -i -w /app -e MODE=dry -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 $P node - < /tmp/zz-fx-reset.js 2>&1 | cut -c1-300 | head -20
