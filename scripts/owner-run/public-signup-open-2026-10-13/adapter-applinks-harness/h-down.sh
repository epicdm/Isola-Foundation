#!/bin/bash
# tears down ONLY the isolated acceptance harness created by h-up.sh (containers named pgn, world-n, plstub-*, ad-old-*, ad-new-*; network plj-net2; its generated key files)
for n in $(docker ps -a --format '{{.Names}}' | grep -E '^(pgn|world-n|plstub-|ad-old-|ad-new-)'); do docker rm -f $n >/dev/null 2>&1; done
docker network rm plj-net2 >/dev/null 2>&1
R=/var/tmp/plstage-n; rm -f $R/adapter_bearer $R/ctx_key $R/pl_key $R/cw_token $R/dburl $R/world.js $R/plstub.mjs $R/adapter-old.mjs $R/adapter-new.mjs $R/driver.mjs; rmdir $R 2>/dev/null
echo "remaining harness containers: $(docker ps -a --format '{{.Names}}' | grep -cE '^(pgn|world-n|plstub-|ad-old-|ad-new-)'); network: $(docker network ls --format '{{.Name}}' | grep -c '^plj-net2$'); dir: $([ -d $R ] && echo present || echo gone)"
