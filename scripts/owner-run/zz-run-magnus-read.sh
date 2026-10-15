#!/bin/bash
# READ-ONLY: run the staged Magnus read script (/tmp/magnus-tester.js: owner user 613 first, then user 101) inside plsvc; credentials are parsed in-process and never printed.
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
docker exec -i -w /app $P node - < /tmp/magnus-tester.js 2>&1 | head -${1:-16} | cut -c1-330
