#!/bin/bash
# READ-ONLY host04 health snapshot (run as root). Names, hashes, counts and status codes only; no env values, no secrets.
echo "== $(date -u +%FT%TZ)"
for s in plsvc-app uplink-app-prod relay; do
  n=$(docker service ls --format '{{.Name}}' | grep -E "uplink_${s}\$|sf-relay|${s}" | head -1)
done
for n in uplink_plsvc-app uplink_uplink-app-prod; do
  echo "-- $n image: $(docker service inspect $n --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' | cut -c1-110) | env names: $(docker service inspect $n --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | cut -d= -f1 | wc -l)"
  docker service ps $n --no-trunc --format '{{.Name}} {{.CurrentState}} {{.Error}}' | head -4 | cut -c1-140
done
echo "-- running containers restarts:"
for n in uplink_plsvc-app uplink_uplink-app-prod; do c=$(docker ps -q -f name=$n -f status=running | head -1); echo "$n $(docker inspect $c --format '{{.RestartCount}} started={{.State.StartedAt}}')"; done
echo "-- relay / adapter / pl-watch:"
docker ps --format '{{.Names}} {{.Status}}' | grep -i -E "relay|adapter" | cut -c1-120
systemctl list-timers --all 2>/dev/null | grep -i pl-watch | cut -c1-160
echo "-- runtime flags file sha256: $(sha256sum /home/epicadmin/plprod/runtime-flags.json | cut -c1-8)...$(sha256sum /home/epicadmin/plprod/runtime-flags.json | cut -c61-64)"
python3 -c "import json;d=json.load(open('/home/epicadmin/plprod/runtime-flags.json'));print({k:(len(v) if isinstance(v,list) else v) for k,v in d.items() if k.startswith('LITE_ADMISSION') or k.startswith('PL_CONCIERGE_SVC_PROV') or k=='LITE_SELF_SERVE_ENABLED'})"
PLDB=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
echo "-- allowlist rows: $(docker exec $PLDB psql -U postgres -d isolav2_prod -X -At -c "select count(*)||' rows, active '||count(*) filter (where \"revokedAt\" is null)||', has_star '||bool_or(identity='*') from lite_activation_allowlist" </dev/null)"
PL=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
echo "-- plsvc LITE_ACTIVATION_ENABLED in process env: [$(docker exec $PL sh -c "tr '\\0' '\\n' </proc/1/environ | grep '^LITE_ACTIVATION_ENABLED=' | cut -d= -f2" </dev/null)]"
echo "-- plsvc HTTP (internal, 3 tries):"
IP=$(docker inspect $PL --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}')
PRT=$(docker exec $PL sh -c "tr '\0' '\n' </proc/1/environ | grep '^PORT=' | cut -d= -f2" </dev/null); echo "port=$PRT"; for i in 1 2 3; do curl -s -o /dev/null -m 5 -w '%{http_code} ' http://$IP:${PRT:-3000}/ ; done; echo
echo "-- public Flow endpoint (external hostname, GET) and uplink app:"
for u in https://go.uplink.epic.dm/ ; do printf "%s -> " $u; curl -s -o /dev/null -m 8 -w '%{http_code}\n' $u; done
echo "-- gate/ledger (counts only):"
UDB=$(docker ps -q -f name=uplink_uplink-db | head -1)
[ -n "$UDB" ] && echo "uplink-db container present" || echo "(uplink db container not matched by name)"
