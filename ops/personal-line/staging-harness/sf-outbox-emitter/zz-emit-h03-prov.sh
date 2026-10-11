#!/bin/bash
# host03 STAGING ONLY: connect the synthetic workspace's Personal Line integration via the fork app's own functions (one-shot service).
# usage: zz-emit-h03-prov.sh <org_id>.  Asserts target (uplink staging DB identity + the org is a synthetic staging workspace) first.
set -e
D=/home/epicadmin/zz-emit-20261011
ORG=${1:?org}
dk() { sudo -n docker "$@"; }
cat > $D/q-org.sql <<EOF
select 'ORG ' || slug || ' owner=' || (owner_id is not null)::text from organizations where id = '$ORG';
EOF
bash $D/zz-emit-psql.sh uplink $D/q-org.sql
mkdir -p $D/prov && cp $D/zz-emit-prov.ts $D/prov/
N=uplinkstg_zzemit_prov_$(date +%H%M%S)
dk service create --quiet --detach=true --name $N --restart-condition none --network plstg_net --label lane=lane-a --label purpose=zzemit-lifecycle-outbox-staging \
  --secret source=uplinkstg_app_env_v1,target=app_env \
  --secret source=plstg_zzemit_events_key_v1,target=pl_sf_events_key \
  --mount type=bind,source=$D/prov,target=/prov,readonly \
  --env ORG=$ORG --env NODE_ENV=production --env DB_DRIVER=pg --env NEON_LOCAL_HOST=uplink-db \
  lane-a-uplink-app:acctslice-7feab80b sh -c 'set -a; . /run/secrets/app_env; set +a; cd /app/packages/crm && cp /prov/zz-emit-prov.ts ./zz-emit-prov.ts && ./node_modules/.bin/tsx zz-emit-prov.ts' >/dev/null
for i in $(seq 1 90); do s=$(dk service ps $N --format '{{.CurrentState}}' | head -1); case "$s" in Complete*|Failed*|Rejected*) break;; esac; sleep 2; done
echo "service=$N state=$s"
dk service logs --raw $N 2>&1 | grep -vE "^\s*at " | tail -n 15
