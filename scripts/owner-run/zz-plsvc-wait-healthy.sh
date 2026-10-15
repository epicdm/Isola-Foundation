#!/bin/bash
# READ-ONLY: wait up to 120 s for the running plsvc container to answer HTTP on its PORT, print status codes and task state.
end=$((SECONDS+120)); ok=0
while [ $SECONDS -lt $end ]; do
  PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
  if [ -n "$PL" ]; then
    IP=$(docker inspect $PL --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}')
    c=$(curl -s -o /dev/null -m 4 -w '%{http_code}' http://$IP:3005/)
    echo "$(date -u +%T) http=$c health=$(docker inspect $PL --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohc{{end}} restarts={{.RestartCount}}')"
    if [ "$c" != "000" ]; then ok=$((ok+1)); [ $ok -ge 3 ] && break; fi
  fi
  sleep 3
done
docker service ps uplink_plsvc-app --format '{{.Name}} {{.CurrentState}} {{.Error}}' | head -3 | cut -c1-120
echo "flow pings since deploy:"; docker logs --since 3m $(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1) 2>&1 | grep -c "action=ping"
