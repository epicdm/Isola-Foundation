#!/bin/bash
# zz-acct2: run the engine reference probe inside OUR plsvc staging container. Asserts the target first.
set -e
D=/home/epicadmin/zz-acct2-20261011
dk() { sudo -n docker "$@"; }
C=$(dk ps -q -f name=plstg_zzacct2_web | head -1)
NAME=$(dk inspect $C --format '{{.Name}}')
case "$NAME" in /plstg_zzacct2_web.*) echo "target ok: $NAME" >&2;; *) echo "ABORT: target $NAME" >&2; exit 1;; esac
dk cp $D/zz-acct2-engine-probe.mjs $C:/tmp/zz-acct2-engine-probe.mjs
cat $D/keys/summary | dk exec -i $C node /tmp/zz-acct2-engine-probe.mjs "$1"
dk exec $C rm -f /tmp/zz-acct2-engine-probe.mjs
