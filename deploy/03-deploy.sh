#!/usr/bin/env bash
###############################################################################
# Runs ON host03. Deploys the isola360uat stack and waits for it to SERVE.
###############################################################################
set -uo pipefail

SHORT="b59b8f0c"
DIR="/home/epicadmin/builds/isola360-${SHORT}"
export IMAGE_TAG="${SHORT}"

# Not secret: a database name and a base URL. The API KEY is a swarm secret and
# is deliberately absent from this file and from the service spec.
export ODOO_URL="https://epic-communications-inc.odoo.com"
export ODOO_DB="epic-communications-inc"

cd "$DIR"

echo "=== PRE-STATE: what exists before this deploy (rollback baseline) ==="
echo "  isola360uat services now: $(sudo docker service ls --filter name=isola360uat -q | wc -l)"
echo "  CONTROL total services on host: $(sudo docker service ls -q | wc -l)"
echo "  image present: $(sudo docker image inspect isola-foundation-360:${SHORT} --format '{{.Id}}' 2>/dev/null || echo MISSING)"

echo
echo "=== deploying stack isola360uat ==="
sudo -E docker stack deploy \
  --resolve-image never \
  -c deploy/stack.yml isola360uat 2>&1 | sed 's/^/  /'

echo
echo "=== waiting for the app to converge and SERVE ==="
for i in $(seq 1 60); do
  rep=$(sudo docker service ls --filter name=isola360uat_app --format '{{.Replicas}}' 2>/dev/null)
  cid=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=isola360uat_app | head -1)
  health=""
  if [ -n "$cid" ]; then
    health=$(sudo docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' 2>/dev/null)
    # Probe what it SERVES, not merely that a process exists.
    code=$(sudo docker exec "$cid" curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null)
  fi
  echo "  [${i}] replicas=${rep:-?} health=${health:-?} internal_health_http=${code:-?}"
  [ "${code:-}" = "200" ] && { echo "  SERVING"; break; }
  [ "$i" = "60" ] && echo "  DID NOT CONVERGE"
  sleep 5
done

echo
echo "=== task state (why, if it failed) ==="
sudo docker service ps isola360uat_app --no-trunc --format \
  '  {{.Name}} {{.CurrentState}} {{.Error}}' 2>/dev/null | head -8

echo
echo "=== last app logs ==="
sudo docker service logs isola360uat_app --tail 40 2>&1 | sed 's/^/  /' | tail -45
