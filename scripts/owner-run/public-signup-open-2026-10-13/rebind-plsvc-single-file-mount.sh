#!/bin/bash
F=/home/epicadmin/plprod/runtime-flags.json
echo "host file (stage1 open+paused) sha: $(sha256sum $F | cut -c1-16)"
echo "plsvc service before: $(docker service ls --format '{{.Name}} {{.Replicas}} {{.Image}}' | grep plsvc | sed 's/@sha256:\(........\).*/@\1/')"
docker service update --force uplink_plsvc-app 2>&1 | tail -2
for i in $(seq 1 40); do sleep 3; P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1); [ -n "$P" ] && docker ps --format '{{.Status}}' -f id=$P | grep -q healthy && break; done
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
echo "plsvc now: $(docker ps --format '{{.Names}} {{.Status}}' -f id=$P)"
echo "container view sha: $(docker exec -i $P sh -c 'sha256sum /app/data/runtime-flags.json | cut -c1-16' </dev/null)  host inode $(stat -c %i $F)  container inode $(docker exec -i $P sh -c 'stat -c %i /app/data/runtime-flags.json' </dev/null)"
