#!/bin/bash
# READ-ONLY: HTTP status of the running plsvc from INSIDE its container (host-side curl to the overlay IP is not reachable), plus recent Flow endpoint activity counts.
PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
for path in / /api/health /go/x; do
  printf "%s -> " $path
  docker exec $PL node -e "fetch('http://127.0.0.1:3005$path',{redirect:'manual'}).then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.message))" </dev/null
done
echo "plsvc log since 06:18Z (lines / flow pings / errors):"
L=$(docker logs --since 2026-10-14T06:18:00Z $PL 2>&1); echo "$(echo "$L" | wc -l) / $(echo "$L" | grep -c 'action=ping') / $(echo "$L" | grep -c -i -E 'error|fatal')"
echo "$L" | grep -i -E 'error|fatal' | cut -c1-160 | tail -3
