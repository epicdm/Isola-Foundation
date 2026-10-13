#!/bin/bash
# zz-acct2: bring up the Uplink app (acctslice-7feab80b) as an isolated STAGING service + loopback-only edge. Asserts target first.
set -e
D=/home/epicadmin/zz-acct2-20261011
dk() { sudo -n docker "$@"; }
[ "$(hostname)" = "host03" ] || { echo "ABORT: not host03"; exit 1; }
dk network ls --format '{{.Name}}' | grep -qx plstg_net || { echo "ABORT: plstg_net missing"; exit 1; }
if dk service inspect uplinkstg_zzacct2_app >/dev/null 2>&1; then echo "ABORT: app exists"; exit 1; fi
NETID=$(dk network inspect plstg_net --format '{{.ID}}')
SINKIP=$(dk service inspect uplinkstg_zzacct2_sink --format '{{range .Endpoint.VirtualIPs}}{{.NetworkID}} {{.Addr}}{{"\n"}}{{end}}' | awk -v n="$NETID" '$1==n{print $2}' | cut -d/ -f1)
[ -n "$SINKIP" ] || { echo "ABORT: no sink VIP"; exit 1; }
echo "sink VIP on plstg_net: $SINKIP"
dk service inspect uplinkstg_app_acctslice > $D/insp-app.json
python3 $D/zz-acct2-mkspec.py app $D/insp-app.json $D/spec-app.json $SINKIP
sudo -n curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/services/create -H 'Content-Type: application/json' -d @$D/spec-app.json | head -c 300
echo
cat > $D/edge.conf <<'NGX'
events {}
http {
  resolver 127.0.0.11 valid=10s;
  map $http_origin $zz_origin {
    "http://127.0.0.1:18612" "https://uplink.epic.dm";
    default $http_origin;
  }
  server {
    listen 8080;
    location /__mailsink/ {
      set $sink http://zzacct2-sink:8025;
      proxy_pass $sink;
    }
    location / {
      set $app http://zzacct2-app:3000;
      proxy_pass $app;
      proxy_set_header Host uplink.epic.dm;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header Origin $zz_origin;
      proxy_redirect https://uplink.epic.dm/ http://127.0.0.1:18612/;
      proxy_redirect http://uplink.epic.dm/ http://127.0.0.1:18612/;
      proxy_read_timeout 120s;
    }
  }
}
NGX
chmod 644 $D/edge.conf
if dk ps -a --format '{{.Names}}' | grep -qx zz_acct2_edge; then echo "edge exists"; else
  dk run -d --name zz_acct2_edge --network plstg_net -p 127.0.0.1:18612:8080 -v $D/edge.conf:/etc/nginx/nginx.conf:ro nginx:1.27-alpine >/dev/null
fi
dk ps --format '{{.Names}} {{.Ports}}' | grep zz_acct2
dk service ls --format '{{.Name}} {{.Image}} {{.Replicas}}' | grep zzacct2
