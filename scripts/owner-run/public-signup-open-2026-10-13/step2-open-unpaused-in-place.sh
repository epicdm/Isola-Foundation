#!/bin/bash
F=/home/epicadmin/plprod/runtime-flags.json
[ "$(sha256sum $F | cut -c1-64)" = "575bc9fb620703600d4e3ee61a6a7b491c66870a2e3246a5ce59fea7c3df4cfe" ] || { echo "ABORT: not at STAGE1 sha"; exit 9; }
I0=$(stat -c %i $F)
cat /tmp/flags-final.json > $F      # IN PLACE (same inode): the plsvc container bind-mounts this single file
echo "STEP2 written (open, NOT paused): $(sha256sum $F | cut -c1-64)  inode before/after: $I0/$(stat -c %i $F)"
sleep 12
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
echo "container view sha: $(docker exec -i $P sh -c 'sha256sum /app/data/runtime-flags.json | cut -c1-64' </dev/null)"
