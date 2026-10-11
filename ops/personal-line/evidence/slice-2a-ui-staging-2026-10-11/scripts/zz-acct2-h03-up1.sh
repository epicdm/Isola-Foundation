#!/bin/bash
# zz-acct2: bring up mock + sink + plsvc on host03 STAGING (plstg_net). Asserts target first.
set -e
D=/home/epicadmin/zz-acct2-20261011
dk() { sudo -n docker "$@"; }
# --- target assertion
NET=$(dk network ls --format '{{.Name}}' | grep -x plstg_net) || { echo "ABORT: plstg_net missing"; exit 1; }
echo "target network: $NET; swarm: $(dk info --format '{{.Swarm.LocalNodeState}}'); host: $(hostname)"
for s in plstg_zzacct2_mock uplinkstg_zzacct2_sink plstg_zzacct2_web; do
  if dk service inspect $s >/dev/null 2>&1; then echo "ABORT: $s already exists"; exit 1; fi
done
# --- mock (own copy of the shared stand-in, patched for explicit ids + AMI peer)
python3 $D/zz-acct2-patchmock.py /home/epicadmin/zz-lanea-plsvc-20261009/mock/mock-ext.mjs $D/mock/zz-acct2-mock.mjs
chmod 644 $D/mock/zz-acct2-mock.mjs
dk service create --name plstg_zzacct2_mock --network name=plstg_net,alias=zzacct2-mock --label lane=lane-a --label purpose=zzacct2-slice-2a-ui-acceptance-staging \
  --mount type=bind,src=$D/mock,dst=/mock,ro --restart-condition any node:22-slim node /mock/zz-acct2-mock.mjs >/dev/null
dk service create --name uplinkstg_zzacct2_sink --network name=plstg_net,alias=zzacct2-sink --label lane=lane-a --label purpose=zzacct2-slice-2a-ui-acceptance-staging \
  --mount type=bind,src=$D,dst=/s,ro --restart-condition any node:22-slim node /s/sinkd/zz-acct2-sink.mjs >/dev/null
# --- plsvc secret + service
dk secret create plstg_zzacct2_sf_key_v1 $D/keys/summary >/dev/null
SID=$(dk secret inspect plstg_zzacct2_sf_key_v1 --format '{{.ID}}')
dk service inspect plstg_web_acctsum > $D/insp-plsvc.json
python3 $D/zz-acct2-mkspec.py plsvc $D/insp-plsvc.json $D/spec-plsvc.json x $SID
sudo -n curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/services/create -H 'Content-Type: application/json' -d @$D/spec-plsvc.json | head -c 300
echo
dk service ls --format '{{.Name}} {{.Image}} {{.Replicas}}' | grep zzacct2
