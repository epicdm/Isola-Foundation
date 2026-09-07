#!/usr/bin/env bash
###############################################################################
# Runs ON host03. Deploys the isola360uat stack at commit d70ef7ad, with
# DEPLOY_SHA now DECLARED in stack.yml rather than imperatively patched.
###############################################################################
set -uo pipefail

SHORT="6cabce31"
DIR="/home/epicadmin/builds/isola360-${SHORT}"
export IMAGE_TAG=6cabce31
export DEPLOY_SHA=6cabce3122cd8523d9b2659b13547a8a838a43cf

export ISSUER_URL="https://isola-360-auth.saas00.epic.dm/realms/isola"
export TENANT_MASTER_KEY="$(cat /home/epicadmin/builds/.tenant_master_key)"

export ODOO_URL=http://isola_erp:8069
export ODOO_DB=erp

cd "$DIR"

echo "=== PRE-STATE: rollback baseline ==="
echo "  isola360uat services now: $(sudo docker service ls --filter name=isola360uat -q | wc -l)"
echo "  CONTROL total services on host: $(sudo docker service ls -q | wc -l)"
echo "  current running task image: $(sudo docker service ps isola360uat_app --filter desired-state=running --format '{{.Image}}' 2>/dev/null)"

echo
echo "=== deploying stack isola360uat (image ${IMAGE_TAG}) ==="
sudo -E docker stack deploy \
  --resolve-image never \
  -c deploy/stack.yml isola360uat 2>&1 | sed 's/^/  /'

echo
echo "=== waiting for the app to converge and SERVE the new image ==="
for i in $(seq 1 60); do
  rep=$(sudo docker service ls --filter name=isola360uat_app --format '{{.Replicas}}' 2>/dev/null)
  cid=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=isola360uat_app | head -1)
  img=""
  code=""
  if [ -n "$cid" ]; then
    img=$(sudo docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null)
    code=$(sudo docker exec "$cid" curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null)
  fi
  echo "  [${i}] replicas=${rep:-?} running_image=${img:-?} internal_health_http=${code:-?}"
  [ "${code:-}" = "200" ] && [ "${img#*:}" = "${SHORT}" ] && { echo "  SERVING THE NEW IMAGE"; break; }
  [ "$i" = "60" ] && echo "  DID NOT CONVERGE ON THE NEW IMAGE"
  sleep 5
done

echo
echo "=== task state ==="
sudo docker service ps isola360uat_app --no-trunc --format '  {{.Name}} {{.CurrentState}} {{.Error}}' 2>/dev/null | head -8

echo
echo "=== last app logs ==="
sudo docker service logs isola360uat_app --tail 30 2>&1 | sed 's/^/  /' | tail -35
