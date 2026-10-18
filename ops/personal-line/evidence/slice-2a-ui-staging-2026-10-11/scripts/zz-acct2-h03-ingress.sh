#!/bin/bash
# zz-acct2: run the ingress sender inside OUR app container. usage: zz-acct2-h03-ingress.sh '<json events>'
set -e
D=/home/epicadmin/zz-acct2-20261011
ORG=c83151fb-e8e1-429b-b27a-eaeac6375e4a
dk() { sudo -n docker "$@"; }
C=$(dk ps -q -f name=uplinkstg_zzacct2_app | head -1)
NAME=$(dk inspect $C --format '{{.Name}}')
case "$NAME" in /uplinkstg_zzacct2_app.*) echo "target ok: $NAME org=$ORG" >&2;; *) echo "ABORT: target $NAME" >&2; exit 1;; esac
dk cp $D/zz-acct2-ingress.mjs $C:/tmp/zz-acct2-ingress.mjs
cat $D/keys/events | dk exec -i $C node /tmp/zz-acct2-ingress.mjs "$ORG" "$1"
dk exec $C rm -f /tmp/zz-acct2-ingress.mjs
