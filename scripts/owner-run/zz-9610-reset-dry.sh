#!/bin/bash
# DRY RUN ONLY (zero mutations) of the supported fixture-reset route for the OWNER's fixture 17672859610 (9610). Run as root on host04; needs /tmp/zz-fx-reset.js staged beside. Widened detail print (900 chars) so the whole preview is readable.
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
sed 's/slice(0, 170)/slice(0, 1100)/' /tmp/zz-fx-reset.js > /tmp/zz-fx-reset-wide.js
docker exec -i -w /app -e MODE=dry -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 $P node - < /tmp/zz-fx-reset-wide.js 2>&1 | fold -w 200
