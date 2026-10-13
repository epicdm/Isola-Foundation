#!/bin/bash
# zz-acct2 cleanup: removes ONLY resources carrying the zzacct2 names/labels (no recursive deletes).
dk() { sudo -n docker "$@"; }
for s in uplinkstg_zzacct2_app plstg_zzacct2_web plstg_zzacct2_mock uplinkstg_zzacct2_sink; do
  case "$s" in *zzacct2*) dk service rm "$s" 2>&1 | tail -1;; esac
done
dk rm -f zz_acct2_edge 2>&1 | tail -1
sleep 5
dk secret rm plstg_zzacct2_sf_key_v1 2>&1 | tail -1
D=/home/epicadmin/zz-acct2-20261011
rm -f $D/tls/ca.key $D/tls/sink.key $D/tls/sink.csr $D/tls/ca.crt $D/tls/sink.crt $D/tls/san.ext $D/tls/ca.srl $D/keys/events $D/keys/summary $D/insp-app.json $D/insp-plsvc.json $D/spec-app.json $D/spec-plsvc.json
echo "--- remaining zzacct2 resources:"
dk service ls --format '{{.Name}}' | grep zzacct2 || echo "services: none"
dk ps -a --format '{{.Names}}' | grep zz_acct2 || echo "containers: none"
dk secret ls --format '{{.Name}}' | grep zzacct2 || echo "secrets: none"
ls -R $D | head -30
