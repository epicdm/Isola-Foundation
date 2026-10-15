#!/bin/bash
# READ-ONLY: wait up to 120 s for the NEW uplink-app-prod task to answer HTTP; print image digest prefix, task states, restarts, and a COUNT of the rate-limit switch names in the process env.
end=$((SECONDS+120)); ok=0
while [ $SECONDS -lt $end ]; do
  C=$(docker ps -q -f name=uplink_uplink-app-prod -f status=running | head -1)
  if [ -n "$C" ]; then
    PRT=$(docker exec $C sh -c "tr '\\0' '\\n' </proc/1/environ | grep '^PORT=' | tail -1 | cut -d= -f2" </dev/null)
    s=$(docker exec $C node -e "fetch('http://127.0.0.1:${PRT:-3000}/',{redirect:'manual'}).then(r=>console.log(r.status)).catch(e=>console.log('ERR'))" </dev/null)
    echo "$(date -u +%T) http=$s started=$(docker inspect $C --format '{{.State.StartedAt}}' | cut -c12-19) restarts=$(docker inspect $C --format '{{.RestartCount}}')"
    if [ "$s" != "ERR" ] && [ -n "$s" ]; then ok=$((ok+1)); [ $ok -ge 3 ] && break; fi
  fi
  sleep 4
done
echo "image: $(docker service inspect uplink_uplink-app-prod --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' | grep -o 'sha256:[0-9a-f]\{8\}')"
docker service ps uplink_uplink-app-prod --format '{{.Name}} {{.CurrentState}} {{.Error}}' | head -3 | cut -c1-120
echo "switch names present in process env: $(docker exec $(docker ps -q -f name=uplink_uplink-app-prod -f status=running | head -1) sh -c "tr '\\0' '\\n' </proc/1/environ | grep -c '^PUBLIC_TURN_'" </dev/null) (expect 3)"
