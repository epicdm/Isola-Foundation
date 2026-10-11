#!/bin/bash
# host03 STAGING ONLY (Swarm services on plstg_net; unique prefix zzemit): mock + plsvc(from this lane's image) + fork(PR#12 head image).
# usage: zz-emit-h03-up.sh <plsvc_image_tag> <org_id> <wa_ids_csv>
# Asserts the target first; refuses if any of OUR service names already exists. No secret value is printed.
set -e
D=/home/epicadmin/zz-emit-20261011
IMG=${1:?plsvc image}; ORG=${2:?org}; WAS=${3:?wa ids}
dk() { sudo -n docker "$@"; }
mkdir -p $D/mock $D/keys && chmod 700 $D/keys
NET=$(dk network ls --format '{{.Name}}' | grep -x plstg_net) || { echo "ABORT: plstg_net missing"; exit 1; }
echo "target network: $NET; swarm: $(dk info --format '{{.Swarm.LocalNodeState}}'); host: $(hostname)"
dk image inspect "$IMG" --format 'plsvc image {{.Id}}' || { echo "ABORT: image $IMG not loaded"; exit 1; }
dk image inspect lane-a-uplink-app:acctslice-7feab80b --format 'fork image {{.Id}} (PR#12 head 7feab80b)'
for s in plstg_zzemit_mock plstg_zzemit_web uplinkstg_zzemit_app; do
  if dk service inspect $s >/dev/null 2>&1; then echo "ABORT: $s already exists"; exit 1; fi
done
# --- own copy of the shared mock (read-only source); assert the stand-in features we rely on exist
SRC=/home/epicadmin/zz-lanea-plsvc-20261009/mock/mock-ext.mjs
cp /home/epicadmin/zz-acct2-20261011/zz-acct2-patchmock.py $D/zz-emit-patchmock.py   # read-only reuse of the existing patcher (explicit-id saves + AMI /peer stand-in)
python3 $D/zz-emit-patchmock.py $SRC $D/mock/zz-emit-mock.mjs && chmod 644 $D/mock/zz-emit-mock.mjs
grep -q "p === '/__peer'" $D/mock/zz-emit-mock.mjs && grep -q "id: id || nextId(mod)" $D/mock/zz-emit-mock.mjs || { echo "ABORT: patched mock lacks /__peer or explicit-id saves"; exit 1; }
# --- throwaway staging-only key material (files, mode 600, never printed)
umask 077
[ -f $D/keys/events ]    || head -c 48 /dev/urandom | base64 -w0 | tr '+/' '-_' > $D/keys/events
[ -f $D/keys/assertion ] || head -c 48 /dev/urandom | base64 -w0 | tr '+/' '-_' > $D/keys/assertion
[ -f $D/keys/cron ]      || head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' > $D/keys/cron
dk secret create plstg_zzemit_events_key_v1 $D/keys/events >/dev/null
SID=$(dk secret inspect plstg_zzemit_events_key_v1 --format '{{.ID}}')
# --- mock service
dk service create --name plstg_zzemit_mock --network name=plstg_net,alias=zzemit-mock --label lane=lane-a --label purpose=zzemit-lifecycle-outbox-staging \
  --mount type=bind,src=$D/mock,dst=/mock,ro --restart-condition any node:22-slim node /mock/zz-emit-mock.mjs >/dev/null
# --- plsvc + fork specs from the existing STAGING specs, posted through the Docker API
dk service inspect plstg_web_acctsum > $D/insp-plsvc.json
dk service inspect uplinkstg_app_acctslice > $D/insp-app.json
python3 $D/zz-emit-mkspec.py plsvc $D/insp-plsvc.json $D/spec-plsvc.json $SID $ORG "$IMG" "$WAS"
python3 $D/zz-emit-mkspec.py app   $D/insp-app.json   $D/spec-app.json
sudo -n curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/services/create -H 'Content-Type: application/json' -d @$D/spec-plsvc.json | head -c 200; echo
sudo -n curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/services/create -H 'Content-Type: application/json' -d @$D/spec-app.json | head -c 200; echo
rm -f $D/spec-plsvc.json $D/spec-app.json $D/insp-plsvc.json $D/insp-app.json   # specs carry env values: do not leave them on disk
dk service ls --format '{{.Name}} {{.Image}} {{.Replicas}}' | grep zzemit
