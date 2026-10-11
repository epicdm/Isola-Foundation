#!/bin/bash
# host03 STAGING ONLY scaffolding for the rc16 store-button proof (nothing production is touched; nothing secret is printed):
#  - a throwaway CA + a graph.facebook.com cert, trusted ONLY by the staging web task (NODE_EXTRA_CA_CERTS) -> metamock
#  - a throwaway Flow RSA keypair (staging web decrypts with it; the harness encrypts with its public half)
#  - the staging recipient allowlist (synthetic 555-01xx block only)
#  - plstg_zzrc16_metamock service on plstg_net (alias metamock)
set -eu
D="sudo -n docker"; H=/home/epicadmin/zz-lanea-rc16-20261011/h
umask 077
mkdir -p $H/tls $H/flowkey
cd $H/tls
[ -f ca.key ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 7 -subj "/CN=zz-rc16-staging-throwaway-ca" 2>/dev/null
[ -f graph.key ] || {
  openssl req -newkey rsa:2048 -nodes -keyout graph.key -out graph.csr -subj "/CN=graph.facebook.com" 2>/dev/null
  printf "subjectAltName=DNS:graph.facebook.com\n" > san.ext
  openssl x509 -req -in graph.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out graph.pem -days 7 -extfile san.ext 2>/dev/null
}
cd $H/flowkey
[ -f flow_private.pem ] || { openssl genrsa -out flow_private.pem 2048 2>/dev/null; openssl rsa -in flow_private.pem -pubout -out flow_public.pem 2>/dev/null; }
# readable by the container users (node runs as non-root in the image); the dir itself stays private to epicadmin + root
chmod 0644 $H/tls/ca.pem $H/tls/graph.pem $H/flowkey/flow_public.pem
chmod 0755 $H $H/tls $H/flowkey
python3 - <<'PY' > $H/allow.json
import json; print(json.dumps(["+1767555%04d" % i for i in range(100, 200)]))
PY
chmod 0644 $H/allow.json
cp /tmp/zzrc16/metamock.mjs $H/metamock.mjs; cp /tmp/zzrc16/flowdrive.mjs $H/flowdrive.mjs; chmod 0644 $H/*.mjs
echo "ca: $(openssl x509 -in $H/tls/ca.pem -noout -subject) | graph SAN: $(openssl x509 -in $H/tls/graph.pem -noout -ext subjectAltName | tail -1 | tr -d ' ')"
echo "flow pub: $(openssl rsa -pubin -in $H/flowkey/flow_public.pem -noout -text 2>/dev/null | head -1)"
if ! $D service inspect plstg_zzrc16_metamock >/dev/null 2>&1; then
  $D service create --detach --name plstg_zzrc16_metamock --network name=plstg_net,alias=metamock --restart-condition any \
    --mount type=bind,src=$H,dst=/h,readonly node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 node /h/metamock.mjs >/dev/null
fi
for i in $(seq 1 30); do s=$($D service ps plstg_zzrc16_metamock --filter desired-state=running --format '{{.CurrentState}}' | head -1); case "$s" in Running*) break;; esac; sleep 2; done
echo "metamock: $s"
$D service inspect plstg_zzrc16_metamock --format '{{range .Endpoint.VirtualIPs}}{{.NetworkID}} {{.Addr}}{{println}}{{end}}'
$D network inspect plstg_net --format 'plstg_net id={{.Id}} internal={{.Internal}}'
