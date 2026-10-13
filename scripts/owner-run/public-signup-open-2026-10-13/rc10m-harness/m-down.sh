#!/bin/bash
# tears down ONLY the isolated rc10m acceptance harness (containers pgm, world-m, plstub-m, adapter-m, engine-m, relay-old, relay-new; network plj-net3; its generated key files)
for n in $(docker ps -a --format '{{.Names}}' | grep -E '^(pgm|world-m|plstub-m|adapter-m|engine-m|relay-old|relay-new)$'); do docker rm -f $n >/dev/null 2>&1; done
docker network rm plj-net3 >/dev/null 2>&1
R=/var/tmp/plstage-m; rm -f $R/adapter_bearer $R/ctx_key $R/pl_key $R/state_key $R/cw_token $R/cw_bot_secret $R/sf_token $R/dburl $R/world.js $R/engine.mjs $R/plstub.mjs $R/driver.mjs $R/adapter.mjs $R/relay-context.ts; rmdir $R 2>/dev/null
echo "remaining: containers $(docker ps -a --format '{{.Names}}' | grep -cE '^(pgm|world-m|plstub-m|adapter-m|engine-m|relay-old|relay-new)$'), network $(docker network ls --format '{{.Name}}' | grep -c '^plj-net3$'), dir $([ -d $R ] && echo present || echo gone)"
